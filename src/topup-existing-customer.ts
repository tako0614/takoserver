/** PRIVATE, UNMOUNTED fixed topup SQL mechanics. Every result is DATA, never NEW/provider permission.
 * Qualified Root/Auth/human/Clock/native producer and durable pre-API original custody remain absent.
 */

import { canonicalDigest, canonicalJson } from "./json.ts";
import { minorToMicros } from "./money.ts";
import {
  assertMoneyCutoverSqlBackingOrigin,
  MONEY_CUTOVER_EPOCH,
  MONEY_CUTOVER_PERMIT_TABLE,
} from "./money-cutover-sql.ts";
import type { TopUpCommand } from "./org-top-up.ts";
import { type Row, type Sql, SqlError, type SqlStatement } from "./ports.ts";
import { parseSharedFinancialAction } from "./shared-financial-action.ts";
import { type ConsentCandidate, guard } from "./shared-financial-consent-data.ts";
import {
  type CustomerCustodyInput,
  compileCustomerPhase,
} from "./shared-financial-customer-dispatch.ts";
import {
  CUSTOMER_COVERAGE_JOINS,
  CUSTOMER_COVERAGE_MATCH,
  CUSTOMER_CURRENT_CUSTODY_MATCH,
  CUSTOMER_MATCH_CTES,
} from "./shared-financial-customer-journal.ts";
import { createCustomerTrackedExecutionData } from "./shared-financial-customer-tracked-execution.ts";
import {
  createFinancialRetainedR1Store,
  type FinancialR1WriteCommand,
} from "./shared-financial-retained-r1.ts";
import { WALLET_FUNDING_PURPOSE } from "./stripe-settlement.ts";

export interface TopUpExistingCustomerOriginal {
  readonly customer: CustomerCustodyInput;
  readonly r1: FinancialR1WriteCommand;
  readonly consent: ConsentCandidate;
  readonly command: TopUpCommand;
  readonly createdAt: string;
  readonly admissionRef: string;
  readonly acceptanceAttemptRef: string;
  readonly acceptanceReceiptRef: string;
  readonly dispatchAttemptRef: string;
  readonly dispatchReceiptRef: string;
}
type Options = Parameters<typeof createFinancialRetainedR1Store>[0] & { readonly rawSql: Sql };
export type TopUpExecutionData = {
  readonly qualification: "unqualified-private-topup-sql-data-only";
  readonly original: TopUpExistingCustomerOriginal;
  readonly status:
    | "own-acceptance-ack-data"
    | "own-first-dispatch-ack-data"
    | "held-original-get-only";
  readonly observation: unknown;
};
function invalid(): never {
  throw new SqlError("invalid", "closed original topup DATA mismatch");
}
function capture<T>(input: T): T {
  let remaining = 50000,
    remainingBytes = 16777216;
  const active = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 64) invalid();
    if (typeof value === "string") {
      remainingBytes -= new TextEncoder().encode(value).length;
      if (remainingBytes < 0) invalid();
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : invalid();
    if (!value || typeof value !== "object" || active.has(value)) invalid();
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    active.add(value);
    try {
      const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
      const keys = Reflect.ownKeys(value);
      if (keys.length > 50000 || (array && keys.length !== value.length + 1)) invalid();
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string") invalid();
        remainingBytes -= new TextEncoder().encode(key).length;
        if (remainingBytes < 0) invalid();
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (!d || !("value" in d) || d.enumerable !== true) invalid();
        Object.defineProperty(result, key, { value: visit(d.value, depth + 1), enumerable: true });
      }
      return Object.freeze(result);
    } finally {
      active.delete(value);
    }
  }
  return visit(input, 0) as T;
}
function iso(value: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalid();
}
const V = (path: string) => `json_extract(v.data,'$.${path}')`;
// Financial-owned finite history leaf: identical ordered predicates to the fixed
// Customer chain, with only ordered violation OR/outer AND trees balanced. No runtime
// SQL rewriting or Root/helper changes. NULL/unknown still fail the same chain.
const TOPUP_CUSTOMER_CHAIN_MATCH = `(NOT EXISTS(SELECT 1 FROM financial_customer_history_entries e
 LEFT JOIN financial_customer_history_receipts receipt ON receipt.receipt_ref=e.expected_history_receipt_ref
 LEFT JOIN financial_customer_history_receipts previous ON previous.receipt_ref=e.previous_history_receipt_ref
 LEFT JOIN customer_entry_matches valid ON valid.history_ref=e.history_ref AND valid.entry_ref=e.entry_ref
 WHERE e.history_ref=cv.history_ref AND ((((e.journal_sequence>hh.journal_sequence OR (receipt.receipt_ref IS NULL OR receipt.all_rows_match IS NOT 1)) OR ((receipt.entry_ref IS NOT e.entry_ref OR receipt.attempt_ref IS NOT e.coupling_attempt_ref) OR (receipt.history_ref IS NOT e.history_ref OR receipt.journal_sequence IS NOT e.journal_sequence))) OR (((receipt.evidence_kind IS NOT e.evidence_kind OR receipt.command_org_id IS NOT e.command_org_id) OR (receipt.l1_receipt_ref IS NOT e.l1_receipt_ref OR receipt.dispatch_receipt_ref IS NOT e.dispatch_receipt_ref)) OR ((receipt.custody_receipt_ref IS NOT e.custody_receipt_ref OR receipt.original_org_origin IS NOT cv.original_org_origin) OR (receipt.realm_registration IS NOT cv.realm_registration OR receipt.realm_incarnation IS NOT cv.realm_incarnation)))) OR ((e.journal_sequence>0 AND ((previous.receipt_ref IS NULL OR previous.history_ref IS NOT e.history_ref) OR ((previous.journal_sequence IS NOT e.journal_sequence-1 OR receipt.previous_history_receipt_ref IS NOT previous.receipt_ref) OR (receipt.previous_entry_ref IS NOT previous.entry_ref OR receipt.previous_journal_sequence IS NOT previous.journal_sequence)))) OR valid.entry_ref IS NULL))) AND ((EXISTS(SELECT 1 FROM financial_customer_history_entries e JOIN financial_customer_history_receipts receipt ON receipt.entry_ref=e.entry_ref
 WHERE e.history_ref=cv.history_ref AND e.journal_sequence=0 AND e.evidence_kind='genesis' AND receipt.receipt_ref=cv.expected_receipt_ref) AND (SELECT count(*) FROM financial_customer_history_entries e WHERE e.history_ref=cv.history_ref)=hh.journal_sequence+1) AND EXISTS(SELECT 1 FROM financial_customer_history_entries e JOIN financial_customer_history_receipts receipt ON receipt.entry_ref=e.entry_ref
 WHERE e.entry_ref=hh.last_entry_ref AND e.history_ref=cv.history_ref AND e.journal_sequence=hh.journal_sequence
 AND receipt.receipt_ref=hh.last_expected_receipt_ref AND receipt.all_rows_match=1)))`;
// Literal bodies and ordered parameter semantics from actual ce59 org-top-up.ts:339/418.
const INSERT = `INSERT OR IGNORE INTO stripe_top_up_commands
         (org_id, reference, fingerprint, command_json, stripe_key, state, session_id, session_url, dispatched_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`;
const DISPATCH = `UPDATE stripe_top_up_commands SET dispatched_at = ?, updated_at = ?
         WHERE org_id = ? AND reference = ? AND dispatched_at IS NULL AND state = 'pending'`;

/** No caller-selected SQL, plan or provider callback is accepted. S and its exact R are owned constructor inputs. */
export function createTopUpExistingCustomerData(
  options: Options,
  original: TopUpExistingCustomerOriginal,
) {
  const q = capture(original);
  if (
    Object.keys(q).sort().join() !==
    "acceptanceAttemptRef,acceptanceReceiptRef,admissionRef,command,consent,createdAt,customer,dispatchAttemptRef,dispatchReceiptRef,r1"
  )
    invalid();
  const S = options.sql,
    R = options.rawSql,
    epoch = options.writerEpoch;
  const sQuery = Object.getOwnPropertyDescriptor(S, "query"),
    sRun = Object.getOwnPropertyDescriptor(S, "run"),
    sBatch = Object.getOwnPropertyDescriptor(S, "batch");
  const rQuery = Object.getOwnPropertyDescriptor(R, "query"),
    rRun = Object.getOwnPropertyDescriptor(R, "run"),
    rBatch = Object.getOwnPropertyDescriptor(R, "batch");
  for (const p of [sQuery, sRun, sBatch, rQuery, rRun, rBatch])
    if (!p || !("value" in p) || typeof p.value !== "function") invalid();
  const contextJson = JSON.stringify(q); // Preserve before-await detached full original order, including Root auth bytes.
  if (
    new TextEncoder().encode(JSON.stringify(q.customer)).length > 1048576 ||
    new TextEncoder().encode(JSON.stringify(q.r1)).length > 98304 ||
    new TextEncoder().encode(contextJson).length > 2097152
  )
    invalid();
  const retained = createFinancialRetainedR1Store(options);
  const customer = createCustomerTrackedExecutionData(R);
  let held = false,
    accepted = false,
    acceptanceStarted = false,
    dispatchStarted = false;
  function stable() {
    assertMoneyCutoverSqlBackingOrigin(S, { rawSql: R, writerEpoch: epoch });
    for (const [port, name, d] of [
      [S, "query", sQuery],
      [S, "run", sRun],
      [S, "batch", sBatch],
      [R, "query", rQuery],
      [R, "run", rRun],
      [R, "batch", rBatch],
    ] as const) {
      const now = Object.getOwnPropertyDescriptor(port, name);
      if (!now || !("value" in now) || now.value !== d?.value) invalid();
    }
  }
  stable();
  async function observed<T>(read: () => Promise<T>): Promise<T> {
    stable();
    try {
      return await read();
    } finally {
      stable();
    }
  }
  async function query(sql: string, params: readonly (string | number | null)[]) {
    const raw: unknown = await observed(
      () => Reflect.apply(rQuery!.value, R, [sql, params]) as ReturnType<Sql["query"]>,
    );
    const rows = capture(raw);
    if (
      !Array.isArray(rows) ||
      rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))
    )
      invalid();
    return rows as readonly Row[];
  }
  async function readRows() {
    return query(
      `SELECT k.*,a.context_json,a.admission_ref,h.receipt_ref,h.phase,h.previous_receipt_ref,h.all_rows_match,h.context_json AS history_context_json,h.command_json AS history_command_json,
      h.fingerprint AS history_fingerprint,h.stripe_key AS history_stripe_key,h.dispatched_at AS history_dispatched_at,
      h.command_updated_at AS history_updated_at,h.recorded_at,h.attempt_ref
      FROM stripe_top_up_commands k LEFT JOIN financial_top_up_admissions a ON a.org_id=k.org_id AND a.reference=k.reference
      LEFT JOIN financial_top_up_history_receipts h ON h.admission_ref=a.admission_ref
      WHERE k.org_id=? AND k.reference=? ORDER BY h.phase`,
      [q.command.organizationId, q.command.reference],
    );
  }
  function data(status: TopUpExecutionData["status"], observation: unknown): TopUpExecutionData {
    return Object.freeze({
      qualification: "unqualified-private-topup-sql-data-only",
      original: q,
      status,
      observation: capture(observation),
    });
  }
  async function hold(): Promise<TopUpExecutionData> {
    held = true;
    try {
      return data("held-original-get-only", await readRows());
    } catch {
      return data("held-original-get-only", { status: "unknown-read-or-method-drift" });
    }
  }
  function ack(value: unknown, length: number): boolean {
    try {
      const a = capture(value);
      return (
        Array.isArray(a) &&
        a.length === length &&
        a.every(
          (x) =>
            x &&
            typeof x === "object" &&
            Object.keys(x).sort().join() === "changes,rows" &&
            x.changes === 1 &&
            Array.isArray(x.rows) &&
            x.rows.length === 0,
        )
      );
    } catch {
      return false;
    }
  }
  async function payload(dispatchedAt: string | null, updatedAt: string | null) {
    iso(q.createdAt);
    for (const ref of [
      q.admissionRef,
      q.acceptanceAttemptRef,
      q.acceptanceReceiptRef,
      q.dispatchAttemptRef,
      q.dispatchReceiptRef,
    ])
      if (typeof ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/u.test(ref)) invalid();
    if (
      new Set([
        q.admissionRef,
        q.acceptanceAttemptRef,
        q.acceptanceReceiptRef,
        q.dispatchAttemptRef,
        q.dispatchReceiptRef,
      ]).size !== 5
    )
      invalid();
    compileCustomerPhase(q.customer); // Actual closed N data validator; no Customer statement is executed here.
    if (q.customer.phase !== "N" || q.customer.writerEpoch !== epoch) invalid();
    const c = q.command,
      r = q.r1.original,
      action = parseSharedFinancialAction(r.c0.selection.action.body);
    if (
      Object.keys(c).sort().join() !==
      "accountId,amountMicros,amountMinor,cancelUrl,currency,customerId,financialRealm,livemode,organizationId,pricingRevision,purchaseCreditExpiry,purpose,reference,successUrl"
    )
      invalid();
    if (
      !/^cus_[A-Za-z0-9_]{1,240}$/u.test(c.customerId) ||
      !/^acct_[A-Za-z0-9_]{1,240}$/u.test(c.accountId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(c.financialRealm) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(c.pricingRevision)
    )
      invalid();
    const origin = new URL(c.successUrl);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      c.successUrl !== `${origin.origin}/billing?checkout={CHECKOUT_SESSION_ID}` ||
      c.cancelUrl !== `${origin.origin}/billing?checkout=cancelled`
    )
      invalid();
    if (
      action.kind !== "topup" ||
      r.economic.kind !== "topup" ||
      action.organizationId !== c.organizationId ||
      action.reference !== c.reference ||
      action.amountMinor !== c.amountMinor ||
      r.economic.amountMinor !== c.amountMinor ||
      !Number.isSafeInteger(c.amountMinor) ||
      c.amountMinor <= 0 ||
      c.amountMicros !== minorToMicros(c.amountMinor) ||
      c.currency !== "USD" ||
      c.purpose !== WALLET_FUNDING_PURPOSE ||
      c.livemode !== false ||
      c.pricingRevision !== r.economic.pricingRevision ||
      canonicalJson(c.purchaseCreditExpiry) !== canonicalJson(r.economic.purchaseCreditExpiry) ||
      c.amountMinor < r.economic.minimumMinor ||
      c.amountMinor > r.economic.maximumMinor ||
      c.customerId !== q.customer.nativeOriginal.customerId ||
      c.organizationId !== q.customer.nativeOriginal.organizationId ||
      c.accountId !== r.scopeRealm.accountId ||
      c.financialRealm !== r.scopeRealm.financialRealm ||
      r.scopeRealm.writerEpoch !== epoch ||
      r.c0.selection.customer.idempotencyKey !== q.customer.nativeOriginal.commandKey ||
      r.c0.selection.customer.requestFingerprint !== q.customer.nativeOriginal.fingerprint ||
      q.consent.challengeRef !== q.r1.key.challengeRef ||
      q.consent.actionKind !== "topup" ||
      q.consent.actionRef !== c.reference ||
      q.consent.requestFingerprint !== r.c0.challenge.requestFingerprint
    )
      invalid();
    if (dispatchedAt !== null) iso(dispatchedAt);
    if (updatedAt !== null) iso(updatedAt); // Predecessor/own ACK, never wall-clock ordering, proves causal phase order.
    const old = await observed(() => customer.readOriginal(q.customer));
    if (
      old.observation.status !== "matching-original" ||
      old.observation.receipt.evidenceKind !== "customer-verified-binding"
    )
      invalid();
    const joined = await observed(() => retained.readJoinedRetainedR1Data(q.consent.challengeRef));
    if (
      joined.status !== "found" ||
      canonicalJson(joined.original) !== canonicalJson(r) ||
      joined.r1ReceiptRef !== q.r1.r1ReceiptRef ||
      canonicalJson(joined.actionIdentity.action) !== canonicalJson(action)
    )
      invalid();
    const commandJson = canonicalJson(c);
    const fingerprint = await observed(() => canonicalDigest(c));
    const stripeKey = `takoserver_topup_${(await observed(() => canonicalDigest([c.organizationId, c.reference]))).slice(7)}`;
    // A stores only the exact closed terms identity. Full display bytes stay in
    // detached q.r1 and immutable R1 original/receipt, checked by the actual reader.
    const terms = r.selectedTerms;
    const termsSelectionJson = canonicalJson({
      ref: terms.ref,
      digest: terms.digest,
      mediaType: terms.mediaType,
      locale: terms.locale,
      bodyByteLength: terms.bodyByteLength,
      digestRecipe: terms.digestRecipe,
    });
    const r1Json = canonicalJson(q.r1),
      c0Json = canonicalJson({ ...r.c0, scope: r.scopeRealm });
    return {
      q,
      contextJson,
      commandJson,
      fingerprint,
      stripeKey,
      r1Json,
      c0Json,
      termsSelectionJson,
      epoch,
      dispatchedAt,
      updatedAt,
    };
  }
  type Payload = Awaited<ReturnType<typeof payload>>;
  function ctes(current: string) {
    return `WITH v(data) AS (VALUES (?)), customer_match_scope(history_ref) AS MATERIALIZED (
      SELECT ${V("q.customer.history.historyRef")} FROM v), ${CUSTOMER_MATCH_CTES},
      current_topup_proof AS MATERIALIZED (${current})`;
  }
  function proof(p: Payload) {
    const g = guard(q.consent, q.command.organizationId);
    if (g.params.length > 50) invalid();
    const sql = `SELECT 1 FROM v
      JOIN shared_customer_challenges c ON c.challenge_ref IS ${V("q.consent.challengeRef")} AND ${g.sql}
      JOIN financial_payer_grants g ON g.challenge_ref=c.challenge_ref AND g.grant_ref IS ${V("q.consent.grantRef")}
      AND g.grant_incarnation IS ${V("q.consent.grantIncarnation")} AND g.identity_proof_ref IS ${V("q.consent.identityProofRef")}
      AND g.consent_registration_ref IS ${V("q.consent.consentRegistrationRef")} AND g.consent_incarnation IS ${V("q.consent.consentIncarnation")}
      AND g.consent_ref IS ${V("q.consent.consentRef")} AND g.consent_proof_ref IS ${V("q.consent.consentProofRef")} AND g.consent_digest IS ${V("q.consent.consentDigest")}
      AND g.auth_snapshot_json IS ${V("q.consent.auth")} AND g.issuance_attempt IS ${V("q.consent.issuanceAttempt")} AND g.expected_receipt_ref IS ${V("q.consent.receiptRef")} AND g.issued_at IS ${V("q.consent.issuedAt")}
      JOIN financial_payer_consent_witnesses w ON w.grant_ref=g.grant_ref AND w.challenge_ref=c.challenge_ref
      AND w.issuance_attempt IS g.issuance_attempt AND w.consent_registration_ref IS g.consent_registration_ref
      AND w.consent_incarnation IS g.consent_incarnation AND w.consent_ref IS g.consent_ref AND w.consent_proof_ref IS g.consent_proof_ref
      AND w.consent_digest IS g.consent_digest AND w.consumed_at IS g.issued_at
      JOIN financial_payer_consent_receipts cr ON cr.receipt_ref=g.expected_receipt_ref AND cr.grant_ref=g.grant_ref
      AND cr.challenge_ref=c.challenge_ref AND cr.issuance_attempt IS g.issuance_attempt AND cr.created_at IS g.issued_at AND cr.all_rows_match IS 1
      JOIN financial_org_payer_origins po ON po.grant_ref=g.grant_ref AND po.challenge_ref=c.challenge_ref AND po.organization_id=c.organization_id
      AND po.action_kind=c.action_kind AND po.action_ref=c.action_ref AND po.request_fingerprint=c.request_fingerprint
      AND po.principal_id=g.principal_id AND po.principal_incarnation=g.principal_incarnation AND po.principal_binding_ref=g.principal_binding_ref
      AND po.authority_ref=g.authority_ref AND po.credential_incarnation=g.credential_incarnation AND po.writer_epoch=c.writer_epoch
      AND po.account_id=c.account_id AND po.mode=c.mode AND po.billing_authority=c.billing_authority AND po.financial_realm=c.financial_realm
      AND po.issued_at=g.issued_at AND NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=po.origin_ref)
      AND po.consent_registration_ref=g.consent_registration_ref AND po.consent_incarnation=g.consent_incarnation AND po.consent_ref=g.consent_ref
      AND po.consent_proof_ref=g.consent_proof_ref AND po.consent_digest=g.consent_digest AND po.all_rows_match IS 1
      JOIN financial_retained_r1_originals ro ON ro.r1_ref IS ${V("q.r1.key.r1Ref")} AND ro.command_json IS ${V("r1Json")}
      AND ro.challenge_ref=c.challenge_ref AND ro.preparation_ref IS ${V("q.r1.key.preparationRef")} AND ro.receipt_ref IS ${V("q.r1.r1ReceiptRef")}
      JOIN financial_retained_r1_receipts rr ON rr.r1_ref=ro.r1_ref AND rr.receipt_ref=ro.receipt_ref AND rr.command_json=ro.command_json
      AND rr.original_digest=ro.original_digest AND rr.all_rows_match IS 1
      JOIN financial_action_source_registrations ars ON ars.registration_ref=ro.source_registration_ref AND ars.incarnation=ro.source_incarnation
      AND ars.registration_digest=ro.source_registration_digest
      JOIN financial_preproof_challenges c0 ON c0.challenge_ref=ro.challenge_ref AND c0.preparation_ref=ro.preparation_ref AND c0.record_json IS ${V("c0Json")}
      JOIN financial_preproof_challenge_receipts c0r ON c0r.challenge_ref=c0.challenge_ref AND c0r.preparation_ref=c0.preparation_ref
      AND c0r.receipt_ref IS ${V("q.r1.original.c0ReceiptRef")} AND c0r.record_json=c0.record_json AND c0r.all_rows_match IS 1
      WHERE c.action_json IS json_extract(${V("r1Json")},'$.original.c0.selection.action.body')
      AND json_type(c.selection_json,'$.selectedTerms') IS 'object'
      AND json_extract(c.selection_json,'$.selectedTerms') IS ${V("termsSelectionJson")}
      AND NOT EXISTS(SELECT 1 FROM financial_payer_grant_revocations revoked WHERE revoked.grant_ref=g.grant_ref)
      AND EXISTS(SELECT 1 ${CUSTOMER_COVERAGE_JOINS}
      JOIN financial_customer_history_entries e ON e.history_ref=cv.history_ref AND e.transition_ref IS ${V("q.customer.custodyReceiptRef")}
      JOIN financial_customer_history_receipts h ON h.entry_ref=e.entry_ref AND h.receipt_ref IS ${V("q.customer.historyReceiptRef")}
      WHERE cv.history_ref IS ${V("q.customer.history.historyRef")} AND e.evidence_kind='customer-verified-binding'
      AND e.original_command_key IS ${V("q.customer.nativeOriginal.commandKey")} AND e.command_org_id=c.organization_id
      AND e.command_after_customer_id IS ${V("q.command.customerId")} AND e.entry_ref IS ${V("q.customer.entryRef")}
      AND ${CUSTOMER_COVERAGE_MATCH} AND ${TOPUP_CUSTOMER_CHAIN_MATCH} AND ${CUSTOMER_CURRENT_CUSTODY_MATCH})`;
    return { sql, params: [JSON.stringify(p), ...g.params] };
  }
  function statements(p: Payload, dispatch: boolean): readonly SqlStatement[] {
    const full = proof(p),
      prefix = ctes(full.sql);
    const c = q.command;
    const command: SqlStatement = dispatch
      ? { sql: DISPATCH, params: [p.dispatchedAt, p.updatedAt, c.organizationId, c.reference] }
      : {
          sql: INSERT,
          params: [
            c.organizationId,
            c.reference,
            p.fingerprint,
            p.commandJson,
            p.stripeKey,
            q.createdAt,
            q.createdAt,
          ],
        };
    const admission: SqlStatement = {
      sql: `${prefix} INSERT INTO financial_top_up_admissions
      (admission_ref,org_id,reference,fingerprint,command_json,stripe_key,context_json,customer_custody_ref,customer_history_receipt_ref,r1_ref,r1_receipt_ref,grant_ref,consent_receipt_ref,acceptance_receipt_ref,dispatch_receipt_ref,writer_epoch,created_at)
      SELECT ${["q.admissionRef", "q.command.organizationId", "q.command.reference", "fingerprint", "commandJson", "stripeKey", "contextJson", "q.customer.custodyReceiptRef", "q.customer.historyReceiptRef", "q.r1.key.r1Ref", "q.r1.r1ReceiptRef", "q.consent.grantRef", "q.consent.receiptRef", "q.acceptanceReceiptRef", "q.dispatchReceiptRef", "epoch", "q.createdAt"].map(V).join(",")}
      FROM v WHERE changes()=1 AND EXISTS(SELECT 1 FROM current_topup_proof)`,
      params: full.params,
    };
    const phase = dispatch ? "topup-first-dispatch" : "topup-accepted";
    // Singleton v always emits one H1 row. Missing current proof yields match NULL,
    // hence all_rows_match=0 and the unchanged mandatory CHECK aborts the batch.
    const receipt: SqlStatement = {
      sql: `${prefix} INSERT INTO financial_top_up_history_receipts
      (receipt_ref,attempt_ref,admission_ref,phase,previous_receipt_ref,org_id,reference,fingerprint,stripe_key,command_json,context_json,dispatched_at,command_updated_at,recorded_at,all_rows_match)
      SELECT ${V(dispatch ? "q.dispatchReceiptRef" : "q.acceptanceReceiptRef")},
      ${V(dispatch ? "q.dispatchAttemptRef" : "q.acceptanceAttemptRef")},
      ${V("q.admissionRef")},'${phase}',${dispatch ? V("q.acceptanceReceiptRef") : "NULL"},
      ${["q.command.organizationId", "q.command.reference", "fingerprint", "stripeKey", "commandJson", "contextJson"].map((x) => V(x)).join(",")},
      ${dispatch ? V("dispatchedAt") : "NULL"},${V(dispatch ? "updatedAt" : "q.createdAt")},${V(dispatch ? "dispatchedAt" : "q.createdAt")},
      CASE WHEN changes()=1 AND current_match.matched IS 1 AND EXISTS(SELECT 1 FROM financial_top_up_admissions a CROSS JOIN v
      WHERE a.admission_ref IS ${V("q.admissionRef")} AND a.context_json IS ${V("contextJson")}
      AND a.command_json IS ${V("commandJson")} AND a.fingerprint IS ${V("fingerprint")} AND a.stripe_key IS ${V("stripeKey")}) THEN 1 ELSE 0 END
      FROM v LEFT JOIN (SELECT 1 AS matched FROM current_topup_proof LIMIT 1) current_match ON 1`,
      params: full.params,
    };
    return dispatch ? [command, receipt] : [command, admission, receipt];
  }
  async function execute(
    dispatch: boolean,
    at: string | null,
    updatedAt: string | null,
  ): Promise<TopUpExecutionData> {
    if (held || (dispatch ? !accepted || dispatchStarted : acceptanceStarted)) return hold();
    if (dispatch) dispatchStarted = true;
    else acceptanceStarted = true;
    try {
      stable();
      if (!dispatch && (await readRows()).length !== 0) return hold();
      const p = await payload(at, updatedAt),
        writes = statements(p, dispatch);
      if (held) return hold();
      stable();
      // Full original guards name the reserved Money tables. Actual S forbids such
      // caller statements; this sealed compiler uses the original R and exact Root
      // permit0/last, like the frozen Customer compiler. No caller SQL/plan is accepted.
      const physical: readonly SqlStatement[] = [
        {
          sql: `INSERT INTO ${MONEY_CUTOVER_PERMIT_TABLE} (singleton, epoch, writer_epoch) VALUES (1, '${MONEY_CUTOVER_EPOCH}', ?)`,
          params: [epoch],
        },
        ...writes,
        {
          sql: `DELETE FROM ${MONEY_CUTOVER_PERMIT_TABLE} WHERE singleton = 1 AND epoch = '${MONEY_CUTOVER_EPOCH}' AND writer_epoch = ?`,
          params: [epoch],
        },
      ];
      const sealed = Object.freeze(
        physical.map((statement) =>
          Object.freeze({
            sql: statement.sql,
            params: Object.freeze([...(statement.params ?? [])]),
          }),
        ),
      );
      const result: unknown = await observed(
        () => Reflect.apply(rBatch!.value, R, [sealed]) as ReturnType<Sql["batch"]>,
      );
      if (held || !ack(result, dispatch ? 4 : 5)) return hold();
      const rows = await readRows();
      const receipt = dispatch ? q.dispatchReceiptRef : q.acceptanceReceiptRef;
      const found = rows.filter(
        (row) =>
          row.receipt_ref === receipt &&
          row.phase === (dispatch ? "topup-first-dispatch" : "topup-accepted") &&
          row.context_json === contextJson &&
          row.command_json === p.commandJson &&
          row.fingerprint === p.fingerprint &&
          row.stripe_key === p.stripeKey &&
          row.all_rows_match === 1 &&
          row.admission_ref === q.admissionRef &&
          row.dispatched_at === at &&
          row.updated_at === (dispatch ? updatedAt : q.createdAt),
      );
      const coherent = rows.every(
        (row) =>
          row.history_context_json === contextJson &&
          row.history_command_json === p.commandJson &&
          row.history_fingerprint === p.fingerprint &&
          row.history_stripe_key === p.stripeKey &&
          row.all_rows_match === 1 &&
          (row.phase === "topup-accepted"
            ? row.receipt_ref === q.acceptanceReceiptRef &&
              row.attempt_ref === q.acceptanceAttemptRef &&
              row.previous_receipt_ref === null &&
              row.history_dispatched_at === null &&
              row.history_updated_at === q.createdAt &&
              row.recorded_at === q.createdAt
            : dispatch &&
              row.phase === "topup-first-dispatch" &&
              row.receipt_ref === q.dispatchReceiptRef &&
              row.attempt_ref === q.dispatchAttemptRef &&
              row.previous_receipt_ref === q.acceptanceReceiptRef &&
              row.history_dispatched_at === at &&
              row.history_updated_at === updatedAt &&
              row.recorded_at === at),
      );
      if (held || !coherent || found.length !== 1 || rows.length !== (dispatch ? 2 : 1))
        return hold();
      if (!dispatch) accepted = true;
      return data(dispatch ? "own-first-dispatch-ack-data" : "own-acceptance-ack-data", rows);
    } catch {
      return hold();
    }
  }
  return Object.freeze({
    accept: () => execute(false, null, null),
    firstDispatch: (dispatchedAt: string, updatedAt: string) =>
      execute(true, dispatchedAt, updatedAt),
    async readOriginal() {
      held = true;
      return hold();
    },
  });
}
