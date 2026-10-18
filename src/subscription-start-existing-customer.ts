/** PRIVATE unmounted subscription START mechanics. Every result is DATA, never NEW/provider permission. */

import { canonicalDigest, canonicalJson } from "./json.ts";
import {
  assertMoneyCutoverSqlBackingOrigin,
  MONEY_CUTOVER_EPOCH,
  MONEY_CUTOVER_PERMIT_TABLE,
} from "./money-cutover-sql.ts";
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

export interface StartExistingCustomerCommand {
  readonly organizationId: string;
  readonly reference: string;
  readonly intentId: string;
  readonly planKey: string;
  readonly pricingRevision: string;
  readonly priceId: string;
  readonly priceAmountMinor: number;
  readonly includedMinor: number;
  readonly livemode: false;
  readonly customerId: string;
  readonly consoleOrigin: string;
  readonly effectiveAt: string;
}
export interface StartExistingCustomerOriginal {
  readonly customer: CustomerCustodyInput;
  readonly r1: FinancialR1WriteCommand;
  readonly consent: ConsentCandidate;
  readonly command: StartExistingCustomerCommand;
  /** Two independent original now().toISOString() observations, not a monotone clock pair. */
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly admissionRef: string;
  readonly acceptanceAttemptRef: string;
  readonly acceptanceReceiptRef: string;
  readonly dispatchAttemptRef: string;
  readonly dispatchReceiptRef: string;
}
type Options = Parameters<typeof createFinancialRetainedR1Store>[0] & {
  readonly rawSql: Sql;
  /** The owning custody constructor's configured data fields; no authority/ready flag. */
  readonly startCatalog: {
    readonly pricingRevision: string;
    readonly effectiveAt: string;
    readonly plans: readonly {
      readonly planId: string;
      readonly stripePriceId: string;
      readonly monthlyAmountMinor: number;
      readonly includedCreditMinor: number;
    }[];
  };
};
export type StartExecutionData = {
  readonly qualification: "unqualified-private-subscription-start-sql-data-only";
  readonly original: StartExistingCustomerOriginal;
  readonly status:
    | "own-acceptance-ack-data"
    | "own-first-dispatch-ack-data"
    | "held-original-get-only";
  readonly observation: unknown;
};
const V = (path: string) => `json_extract(v.data,'$.${path}')`;
// Financial-owned finite Customer chain: same ordered predicates, only homogeneous
// OR17/previous OR6/outer AND4 associations balanced; NULL/unknown remain failclosed.
const START_CUSTOMER_CHAIN_MATCH = `(NOT EXISTS(SELECT 1 FROM financial_customer_history_entries e
 LEFT JOIN financial_customer_history_receipts receipt ON receipt.receipt_ref=e.expected_history_receipt_ref
 LEFT JOIN financial_customer_history_receipts previous ON previous.receipt_ref=e.previous_history_receipt_ref
 LEFT JOIN customer_entry_matches valid ON valid.history_ref=e.history_ref AND valid.entry_ref=e.entry_ref
 WHERE e.history_ref=cv.history_ref AND ((((e.journal_sequence>hh.journal_sequence OR (receipt.receipt_ref IS NULL OR receipt.all_rows_match IS NOT 1)) OR ((receipt.entry_ref IS NOT e.entry_ref OR receipt.attempt_ref IS NOT e.coupling_attempt_ref) OR (receipt.history_ref IS NOT e.history_ref OR receipt.journal_sequence IS NOT e.journal_sequence))) OR (((receipt.evidence_kind IS NOT e.evidence_kind OR receipt.command_org_id IS NOT e.command_org_id) OR (receipt.l1_receipt_ref IS NOT e.l1_receipt_ref OR receipt.dispatch_receipt_ref IS NOT e.dispatch_receipt_ref)) OR ((receipt.custody_receipt_ref IS NOT e.custody_receipt_ref OR receipt.original_org_origin IS NOT cv.original_org_origin) OR (receipt.realm_registration IS NOT cv.realm_registration OR receipt.realm_incarnation IS NOT cv.realm_incarnation)))) OR ((e.journal_sequence>0 AND ((previous.receipt_ref IS NULL OR previous.history_ref IS NOT e.history_ref) OR ((previous.journal_sequence IS NOT e.journal_sequence-1 OR receipt.previous_history_receipt_ref IS NOT previous.receipt_ref) OR (receipt.previous_entry_ref IS NOT previous.entry_ref OR receipt.previous_journal_sequence IS NOT previous.journal_sequence)))) OR valid.entry_ref IS NULL))) AND ((EXISTS(SELECT 1 FROM financial_customer_history_entries e JOIN financial_customer_history_receipts receipt ON receipt.entry_ref=e.entry_ref
 WHERE e.history_ref=cv.history_ref AND e.journal_sequence=0 AND e.evidence_kind='genesis' AND receipt.receipt_ref=cv.expected_receipt_ref) AND (SELECT count(*) FROM financial_customer_history_entries e WHERE e.history_ref=cv.history_ref)=hh.journal_sequence+1) AND EXISTS(SELECT 1 FROM financial_customer_history_entries e JOIN financial_customer_history_receipts receipt ON receipt.entry_ref=e.entry_ref
 WHERE e.entry_ref=hh.last_entry_ref AND e.history_ref=cv.history_ref AND e.journal_sequence=hh.journal_sequence
 AND receipt.receipt_ref=hh.last_expected_receipt_ref AND receipt.all_rows_match=1)))`;
/** Exact actual hosted-adapter begin predicate; never supplied by a caller. */
function nativeManagement(org: string) {
  const common = `NOT EXISTS(SELECT 1 FROM stripe_billing_customer_commands WHERE org_id=? AND state<>'verified')`;
  return {
    condition: `${common} AND NOT EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=?) AND NOT EXISTS(SELECT 1 FROM stripe_subscription_cancellation_intents WHERE org_id=? AND state IN ('prepared','dispatched'))`,
    params: [org, org, org],
  };
}
function invalid(): never {
  throw new SqlError("invalid", "closed original subscription START DATA mismatch");
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
export function createStartExistingCustomerData(
  options: Options,
  original: StartExistingCustomerOriginal,
) {
  const q = capture(original);
  const catalog = capture(options.startCatalog);
  if (
    !catalog ||
    !Array.isArray(catalog.plans) ||
    catalog.plans.length === 0 ||
    new Set(catalog.plans.map((plan) => plan.planId)).size !== catalog.plans.length
  )
    invalid();
  if (
    Object.keys(q).sort().join() !==
    "acceptanceAttemptRef,acceptanceReceiptRef,admissionRef,command,consent,createdAt,customer,dispatchAttemptRef,dispatchReceiptRef,r1,updatedAt"
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
    const key = (
      await observed(() => canonicalDigest([q.command.organizationId, q.command.reference]))
    ).slice(7);
    return query(
      `SELECT k.*,a.context_json,a.command_json,a.admission_ref,a.stripe_key,h.receipt_ref,h.phase,h.previous_receipt_ref,h.all_rows_match,
      h.context_json AS history_context_json,h.command_json AS history_command_json,h.fingerprint AS history_fingerprint,
      h.stripe_key AS history_stripe_key,h.intent_state AS history_state,h.command_updated_at AS history_updated_at,h.recorded_at,h.attempt_ref
      FROM stripe_subscription_checkout_intents k
      LEFT JOIN financial_subscription_start_admissions a ON a.intent_id=k.id
      LEFT JOIN financial_subscription_start_history_receipts h ON h.admission_ref=a.admission_ref
      WHERE k.org_id=? AND k.request_key_digest=? ORDER BY h.phase`,
      [q.command.organizationId, key],
    );
  }
  function data(status: StartExecutionData["status"], observation: unknown): StartExecutionData {
    return Object.freeze({
      qualification: "unqualified-private-subscription-start-sql-data-only",
      original: q,
      status,
      observation: capture(observation),
    });
  }
  async function hold(): Promise<StartExecutionData> {
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
  async function payload(dispatchedAt: string | null) {
    iso(q.createdAt);
    iso(q.updatedAt);
    if (dispatchedAt !== null) iso(dispatchedAt);
    const refs = [
      q.admissionRef,
      q.acceptanceAttemptRef,
      q.acceptanceReceiptRef,
      q.dispatchAttemptRef,
      q.dispatchReceiptRef,
    ];
    if (
      refs.some(
        (ref) => typeof ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/u.test(ref),
      ) ||
      new Set(refs).size !== 5
    )
      invalid();
    compileCustomerPhase(q.customer); // Validator only: no Customer statement is executed here.
    if (q.customer.phase !== "N" || q.customer.writerEpoch !== epoch) invalid();
    const c = q.command,
      r = q.r1.original,
      action = parseSharedFinancialAction(r.c0.selection.action.body);
    if (
      Object.keys(c).sort().join() !==
      "consoleOrigin,customerId,effectiveAt,includedMinor,intentId,livemode,organizationId,planKey,priceAmountMinor,priceId,pricingRevision,reference"
    )
      invalid();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(c.organizationId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(c.reference) ||
      !/^sci_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(c.intentId) ||
      !/^cus_[A-Za-z0-9_]{1,240}$/u.test(c.customerId) ||
      !/^price_[A-Za-z0-9_]{1,240}$/u.test(c.priceId)
    )
      invalid();
    const origin = new URL(c.consoleOrigin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      c.consoleOrigin !== origin.origin
    )
      invalid();
    iso(c.effectiveAt);
    const plan = catalog.plans.find((plan) => plan.planId === c.planKey);
    if (
      !plan ||
      c.pricingRevision !== catalog.pricingRevision ||
      c.effectiveAt !== catalog.effectiveAt ||
      c.priceId !== plan.stripePriceId ||
      c.priceAmountMinor !== plan.monthlyAmountMinor ||
      c.includedMinor !== plan.includedCreditMinor
    )
      invalid();
    if (
      action.kind !== "subscription-start" ||
      r.economic.kind !== "subscription-start" ||
      action.organizationId !== c.organizationId ||
      action.reference !== c.reference ||
      action.planKey !== c.planKey ||
      r.economic.planKey !== c.planKey ||
      r.economic.pricingRevision !== c.pricingRevision ||
      r.economic.priceId !== c.priceId ||
      r.economic.priceAmountMinor !== c.priceAmountMinor ||
      r.economic.includedMinor !== c.includedMinor ||
      r.economic.currency !== "USD" ||
      r.economic.periodMonths !== 1 ||
      c.livemode !== false ||
      c.organizationId !== q.customer.nativeOriginal.organizationId ||
      c.customerId !== q.customer.nativeOriginal.customerId ||
      r.scopeRealm.writerEpoch !== epoch ||
      r.scopeRealm.mode !== "test" ||
      r.c0.selection.customer.idempotencyKey !== q.customer.nativeOriginal.commandKey ||
      r.c0.selection.customer.requestFingerprint !== q.customer.nativeOriginal.fingerprint ||
      q.consent.challengeRef !== q.r1.key.challengeRef ||
      q.consent.actionKind !== "subscription-start" ||
      q.consent.actionRef !== c.reference ||
      q.consent.requestFingerprint !== r.c0.challenge.requestFingerprint
    )
      invalid();
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
    const key = (await observed(() => canonicalDigest([c.organizationId, c.reference]))).slice(7);
    const fingerprint = (
      await observed(() =>
        canonicalDigest([
          c.organizationId,
          c.planKey,
          c.pricingRevision,
          c.priceId,
          c.priceAmountMinor,
          c.includedMinor,
          c.livemode,
          "subscription",
        ]),
      )
    ).slice(7);
    return {
      q,
      contextJson,
      key,
      fingerprint,
      commandJson: canonicalJson(c),
      stripeKey: `takoserver-subscription-checkout:${c.intentId}`,
      r1Json: canonicalJson(q.r1),
      c0Json: canonicalJson({ ...r.c0, scope: r.scopeRealm }),
      termsSelectionJson: canonicalJson({
        ref: r.selectedTerms.ref,
        digest: r.selectedTerms.digest,
        mediaType: r.selectedTerms.mediaType,
        locale: r.selectedTerms.locale,
        bodyByteLength: r.selectedTerms.bodyByteLength,
        digestRecipe: r.selectedTerms.digestRecipe,
      }),
      epoch,
      dispatchedAt,
    };
  }
  type Payload = Awaited<ReturnType<typeof payload>>;
  function ctes(current: {
    readonly sql: string;
    readonly guardSql: string;
    readonly customerSql: string;
  }) {
    // Same-statement guard relation: c is its only outer row binding. Keep the
    // original guard SQL/params opaque, after singleton v's first JSON bind.
    return `WITH v(data) AS (VALUES (?)), start_guard_challenges AS MATERIALIZED (
      SELECT c.* FROM shared_customer_challenges c WHERE ${current.guardSql}),
      customer_match_scope(history_ref) AS MATERIALIZED (
      SELECT ${V("q.customer.history.historyRef")} FROM v), ${CUSTOMER_MATCH_CTES},
      start_customer_proof AS MATERIALIZED (${current.customerSql}),
      current_start_proof AS MATERIALIZED (${current.sql})`;
  }
  function proof(p: Payload) {
    const g = guard(q.consent, q.command.organizationId);
    if (g.params.length > 50) invalid();
    const customerSql = `SELECT e.command_org_id AS organization_id ${CUSTOMER_COVERAGE_JOINS} CROSS JOIN v
      JOIN financial_customer_history_entries e ON e.history_ref=cv.history_ref AND e.transition_ref IS ${V("q.customer.custodyReceiptRef")}
      JOIN financial_customer_history_receipts h ON h.entry_ref=e.entry_ref AND h.receipt_ref IS ${V("q.customer.historyReceiptRef")}
      WHERE ((((cv.history_ref IS ${V("q.customer.history.historyRef")} AND e.evidence_kind='customer-verified-binding') AND (e.original_command_key IS ${V("q.customer.nativeOriginal.commandKey")} AND (e.command_after_customer_id IS ${V("q.command.customerId")} AND e.entry_ref IS ${V("q.customer.entryRef")}))) AND ${CUSTOMER_COVERAGE_MATCH}) AND (${START_CUSTOMER_CHAIN_MATCH} AND ${CUSTOMER_CURRENT_CUSTODY_MATCH}))`;
    const sql = `SELECT 1 FROM v
      JOIN start_guard_challenges c ON c.challenge_ref IS ${V("q.consent.challengeRef")}
      JOIN financial_payer_grants g ON ((((g.challenge_ref=c.challenge_ref AND g.grant_ref IS ${V("q.consent.grantRef")}) AND (g.grant_incarnation IS ${V("q.consent.grantIncarnation")} AND g.identity_proof_ref IS ${V("q.consent.identityProofRef")})) AND ((g.consent_registration_ref IS ${V("q.consent.consentRegistrationRef")} AND g.consent_incarnation IS ${V("q.consent.consentIncarnation")}) AND g.consent_ref IS ${V("q.consent.consentRef")})) AND (((g.consent_proof_ref IS ${V("q.consent.consentProofRef")} AND g.consent_digest IS ${V("q.consent.consentDigest")}) AND g.auth_snapshot_json IS ${V("q.consent.auth")}) AND ((g.issuance_attempt IS ${V("q.consent.issuanceAttempt")} AND g.expected_receipt_ref IS ${V("q.consent.receiptRef")}) AND g.issued_at IS ${V("q.consent.issuedAt")})))
      JOIN financial_payer_consent_witnesses w ON ((((w.grant_ref=g.grant_ref AND w.challenge_ref=c.challenge_ref) AND w.issuance_attempt IS g.issuance_attempt) AND (w.consent_registration_ref IS g.consent_registration_ref AND w.consent_incarnation IS g.consent_incarnation)) AND ((w.consent_ref IS g.consent_ref AND w.consent_proof_ref IS g.consent_proof_ref) AND (w.consent_digest IS g.consent_digest AND w.consumed_at IS g.issued_at)))
      JOIN financial_payer_consent_receipts cr ON (((cr.receipt_ref=g.expected_receipt_ref AND cr.grant_ref=g.grant_ref) AND cr.challenge_ref=c.challenge_ref) AND (cr.issuance_attempt IS g.issuance_attempt AND (cr.created_at IS g.issued_at AND cr.all_rows_match IS 1)))
      JOIN financial_org_payer_origins po ON ((((((po.grant_ref=g.grant_ref AND po.challenge_ref=c.challenge_ref) AND po.organization_id=c.organization_id) AND (po.action_kind=c.action_kind AND po.action_ref=c.action_ref)) AND ((po.request_fingerprint=c.request_fingerprint AND po.principal_id=g.principal_id) AND (po.principal_incarnation=g.principal_incarnation AND po.principal_binding_ref=g.principal_binding_ref))) AND (((po.authority_ref=g.authority_ref AND po.credential_incarnation=g.credential_incarnation) AND (po.writer_epoch=c.writer_epoch AND po.account_id=c.account_id)) AND ((po.mode=c.mode AND po.billing_authority=c.billing_authority) AND (po.financial_realm=c.financial_realm AND po.issued_at=g.issued_at)))) AND (NOT EXISTS(SELECT 1 FROM financial_org_payer_origin_closures closed WHERE closed.origin_ref=po.origin_ref) AND (((po.consent_registration_ref=g.consent_registration_ref AND po.consent_incarnation=g.consent_incarnation) AND po.consent_ref=g.consent_ref) AND (po.consent_proof_ref=g.consent_proof_ref AND (po.consent_digest=g.consent_digest AND po.all_rows_match IS 1)))))
      JOIN financial_retained_r1_originals ro ON ((ro.r1_ref IS ${V("q.r1.key.r1Ref")} AND (ro.command_json IS ${V("r1Json")} AND ro.challenge_ref=c.challenge_ref)) AND (ro.preparation_ref IS ${V("q.r1.key.preparationRef")} AND ro.receipt_ref IS ${V("q.r1.r1ReceiptRef")}))
      JOIN financial_retained_r1_receipts rr ON ((rr.r1_ref=ro.r1_ref AND rr.receipt_ref=ro.receipt_ref) AND (rr.command_json=ro.command_json AND (rr.original_digest=ro.original_digest AND rr.all_rows_match IS 1)))
      JOIN financial_action_source_registrations ars ON ((ars.registration_ref=ro.source_registration_ref AND ars.incarnation=ro.source_incarnation) AND ars.registration_digest=ro.source_registration_digest)
      JOIN financial_preproof_challenges c0 ON ((c0.challenge_ref=ro.challenge_ref AND c0.preparation_ref=ro.preparation_ref) AND c0.record_json IS ${V("c0Json")})
      JOIN financial_preproof_challenge_receipts c0r ON ((c0r.challenge_ref=c0.challenge_ref AND c0r.preparation_ref=c0.preparation_ref) AND (c0r.receipt_ref IS ${V("q.r1.original.c0ReceiptRef")} AND (c0r.record_json=c0.record_json AND c0r.all_rows_match IS 1)))
      WHERE ((c.action_json IS json_extract(${V("r1Json")},'$.original.c0.selection.action.body') AND ((json_type(c.selection_json,'$.selectedTerms') IS 'object' AND json_extract(c.selection_json,'$.selectedTerms') IS ${V("termsSelectionJson")}) AND NOT EXISTS(SELECT 1 FROM financial_payer_grant_revocations revoked WHERE revoked.grant_ref=g.grant_ref))) AND (EXISTS(SELECT 1 FROM start_customer_proof customer WHERE customer.organization_id=c.organization_id) AND EXISTS(SELECT 1 FROM stripe_billing_customers b WHERE b.org_id=c.organization_id AND b.customer_id IS ${V("q.command.customerId")})))`;
    return { sql, guardSql: g.sql, customerSql, params: [JSON.stringify(p), ...g.params] };
  }
  function statements(p: Payload, dispatch: boolean): readonly SqlStatement[] {
    const full = proof(p),
      prefix = ctes(full),
      c = q.command;
    const native = nativeManagement(c.organizationId);
    const shared = {
      condition: `${native.condition} AND EXISTS(SELECT 1 FROM current_start_proof)`,
      params: native.params,
    };
    // Exact public native literal bodies and original typed bind segments are kept below.
    const command: SqlStatement = dispatch
      ? {
          sql:
            prefix +
            ` UPDATE stripe_subscription_checkout_intents SET state = 'dispatched', updated_at = ?
         WHERE id = ? AND state = 'prepared' AND org_id = ? AND pricing_revision = ? AND price_id = ?
           AND price_amount_minor = ? AND included_minor = ? AND customer_id IS ?
           AND (SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?) IS ?
           AND NOT EXISTS (SELECT 1 FROM stripe_billing_subscriptions WHERE org_id = ? AND status NOT IN ('canceled','incomplete_expired'))
           AND NOT EXISTS (SELECT 1 FROM stripe_billing_associations a WHERE a.org_id = ?
             AND a.association_generation = (SELECT MAX(association_generation) FROM stripe_billing_associations WHERE org_id = ?)
             AND NOT EXISTS (SELECT 1 FROM stripe_billing_subscriptions s WHERE s.org_id = a.org_id AND s.subscription_id = a.subscription_id))
           AND (${shared.condition})`,
          params: [
            ...full.params,
            p.dispatchedAt,
            c.intentId,
            c.organizationId,
            c.pricingRevision,
            c.priceId,
            c.priceAmountMinor,
            c.includedMinor,
            c.customerId,
            c.organizationId,
            c.customerId,
            c.organizationId,
            c.organizationId,
            c.organizationId,
            ...shared.params,
          ],
        }
      : {
          sql:
            prefix +
            ` INSERT OR IGNORE INTO stripe_subscription_checkout_intents
       (id,org_id,request_key_digest,fingerprint,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,livemode,customer_id,state,created_at,updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?
       WHERE NOT EXISTS (SELECT 1 FROM stripe_billing_subscriptions WHERE org_id = ? AND status NOT IN ('canceled','incomplete_expired'))
         AND NOT EXISTS (SELECT 1 FROM stripe_subscription_checkout_intents WHERE org_id = ? AND state IN ('prepared','dispatched','session_known'))
         AND NOT EXISTS (SELECT 1 FROM stripe_billing_associations a
           WHERE a.org_id = ? AND a.association_generation =
             (SELECT MAX(association_generation) FROM stripe_billing_associations WHERE org_id = ?)
             AND NOT EXISTS (SELECT 1 FROM stripe_billing_subscriptions s WHERE s.org_id = a.org_id AND s.subscription_id = a.subscription_id))
         AND (${shared.condition})`,
          params: [
            ...full.params,
            c.intentId,
            c.organizationId,
            p.key,
            p.fingerprint,
            c.planKey,
            c.pricingRevision,
            c.priceId,
            c.priceAmountMinor,
            c.includedMinor,
            Number(c.livemode),
            c.customerId,
            q.createdAt,
            q.updatedAt,
            c.organizationId,
            c.organizationId,
            c.organizationId,
            c.organizationId,
            ...shared.params,
          ],
        };
    const admission: SqlStatement = {
      sql: `${prefix} INSERT INTO financial_subscription_start_admissions
      (admission_ref,intent_id,org_id,reference,request_key_digest,fingerprint,command_json,stripe_key,context_json,
       customer_custody_ref,customer_history_receipt_ref,r1_ref,r1_receipt_ref,grant_ref,consent_receipt_ref,
       acceptance_receipt_ref,dispatch_receipt_ref,writer_epoch,created_at,accepted_updated_at)
      SELECT ${[
        "q.admissionRef",
        "q.command.intentId",
        "q.command.organizationId",
        "q.command.reference",
        "key",
        "fingerprint",
        "commandJson",
        "stripeKey",
        "contextJson",
        "q.customer.custodyReceiptRef",
        "q.customer.historyReceiptRef",
        "q.r1.key.r1Ref",
        "q.r1.r1ReceiptRef",
        "q.consent.grantRef",
        "q.consent.receiptRef",
        "q.acceptanceReceiptRef",
        "q.dispatchReceiptRef",
        "epoch",
        "q.createdAt",
        "q.updatedAt",
      ]
        .map(V)
        .join(",")}
      FROM v WHERE changes()=1 AND EXISTS(SELECT 1 FROM current_start_proof)`,
      params: full.params,
    };
    const phase = dispatch ? "subscription-start-first-dispatch" : "subscription-start-accepted";
    // Singleton v emits one mandatory H1 row even when proof is absent. The
    // unchanged all_rows_match CHECK then aborts and rolls back the entire batch.
    const receipt: SqlStatement = {
      sql: `${prefix} INSERT INTO financial_subscription_start_history_receipts
      (receipt_ref,attempt_ref,admission_ref,phase,previous_receipt_ref,intent_id,org_id,reference,request_key_digest,
       fingerprint,stripe_key,command_json,context_json,intent_state,command_updated_at,recorded_at,all_rows_match)
      SELECT ${V(dispatch ? "q.dispatchReceiptRef" : "q.acceptanceReceiptRef")},
      ${V(dispatch ? "q.dispatchAttemptRef" : "q.acceptanceAttemptRef")},
      ${V("q.admissionRef")},'${phase}',${dispatch ? V("q.acceptanceReceiptRef") : "NULL"},
      ${["q.command.intentId", "q.command.organizationId", "q.command.reference", "key", "fingerprint", "stripeKey", "commandJson", "contextJson"].map((x) => V(x)).join(",")},
      '${dispatch ? "dispatched" : "prepared"}',${V(dispatch ? "dispatchedAt" : "q.updatedAt")},
      ${V(dispatch ? "dispatchedAt" : "q.updatedAt")},
      CASE WHEN changes()=1 AND current_match.matched IS 1 AND EXISTS(
       SELECT 1 FROM financial_subscription_start_admissions a CROSS JOIN v
       WHERE a.admission_ref IS ${V("q.admissionRef")} AND a.intent_id IS ${V("q.command.intentId")}
       AND a.context_json IS ${V("contextJson")} AND a.command_json IS ${V("commandJson")}
       AND a.fingerprint IS ${V("fingerprint")} AND a.stripe_key IS ${V("stripeKey")}) THEN 1 ELSE 0 END
      FROM v LEFT JOIN (SELECT 1 AS matched FROM current_start_proof LIMIT 1) current_match ON 1`,
      params: full.params,
    };
    return dispatch ? [command, receipt] : [command, admission, receipt];
  }
  async function execute(dispatch: boolean, at: string | null): Promise<StartExecutionData> {
    if (held || (dispatch ? !accepted || dispatchStarted : acceptanceStarted)) return hold();
    if (dispatch) dispatchStarted = true;
    else acceptanceStarted = true;
    try {
      stable();
      if (!dispatch && (await readRows()).length !== 0) return hold();
      const p = await payload(at);
      // Existing current catalog/provider validation is not re-created here.
      // Retain the actual effectiveAt preflight using the original Clock API and full ISO range.
      const now = options.clock().toISOString();
      if (q.command.effectiveAt > now) return hold();
      const writes = statements(p, dispatch);
      if (held) return hold();
      stable();
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
        physical.map((s) =>
          Object.freeze({ sql: s.sql, params: Object.freeze([...(s.params ?? [])]) }),
        ),
      );
      const result: unknown = await observed(
        () => Reflect.apply(rBatch!.value, R, [sealed]) as ReturnType<Sql["batch"]>,
      );
      if (held || !ack(result, dispatch ? 4 : 5)) return hold();
      const rows = await readRows();
      const coherent = rows.every(
        (row) =>
          row.id === q.command.intentId &&
          row.org_id === q.command.organizationId &&
          row.request_key_digest === p.key &&
          row.fingerprint === p.fingerprint &&
          row.plan_key === q.command.planKey &&
          row.pricing_revision === q.command.pricingRevision &&
          row.price_id === q.command.priceId &&
          row.price_amount_minor === q.command.priceAmountMinor &&
          row.included_minor === q.command.includedMinor &&
          row.customer_id === q.command.customerId &&
          row.livemode === 0 &&
          row.created_at === q.createdAt &&
          row.updated_at === (dispatch ? at : q.updatedAt) &&
          row.state === (dispatch ? "dispatched" : "prepared") &&
          row.session_id === null &&
          row.session_url === null &&
          row.subscription_id === null &&
          row.admission_ref === q.admissionRef &&
          row.context_json === contextJson &&
          row.command_json === p.commandJson &&
          row.history_context_json === contextJson &&
          row.history_command_json === p.commandJson &&
          row.history_fingerprint === p.fingerprint &&
          row.history_stripe_key === p.stripeKey &&
          row.stripe_key === p.stripeKey &&
          row.all_rows_match === 1 &&
          (row.phase === "subscription-start-accepted"
            ? row.receipt_ref === q.acceptanceReceiptRef &&
              row.attempt_ref === q.acceptanceAttemptRef &&
              row.previous_receipt_ref === null &&
              row.history_state === "prepared" &&
              row.history_updated_at === q.updatedAt &&
              row.recorded_at === q.updatedAt
            : dispatch &&
              row.phase === "subscription-start-first-dispatch" &&
              row.receipt_ref === q.dispatchReceiptRef &&
              row.attempt_ref === q.dispatchAttemptRef &&
              row.previous_receipt_ref === q.acceptanceReceiptRef &&
              row.history_state === "dispatched" &&
              row.history_updated_at === at &&
              row.recorded_at === at),
      );
      if (held || !coherent || rows.length !== (dispatch ? 2 : 1)) return hold();
      if (!dispatch) accepted = true;
      return data(dispatch ? "own-first-dispatch-ack-data" : "own-acceptance-ack-data", rows);
    } catch {
      return hold();
    }
  }
  return Object.freeze({
    accept: () => execute(false, null),
    firstDispatch: (dispatchedAt: string) => execute(true, dispatchedAt),
    async readOriginal() {
      held = true;
      return hold();
    },
  });
}
