/** PRIVATE, UNMOUNTED fixed cancel SQL mechanics. Every result is DATA, never NEW/provider permission.
 * Qualified Root/Auth/human/Clock/native producer and durable pre-API original custody remain absent.
 */

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
import type { SubscriptionPlanTarget } from "./stripe-subscription-plan-change.ts";
import type { Association } from "./subscription-custody.ts";

interface CommonOriginal {
  readonly customer: CustomerCustodyInput;
  readonly r1: FinancialR1WriteCommand;
  readonly consent: ConsentCandidate;
  readonly input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly expectedSubscriptionRef: string;
  };
  readonly admissionRef: string;
  readonly acceptanceAttemptRef: string;
  readonly acceptanceReceiptRef: string;
  readonly preparationAttemptRef: string | null;
  readonly preparationReceiptRef: string | null;
  readonly dispatchAttemptRef: string;
  readonly dispatchReceiptRef: string;
}
/** Native intent is captured only when its actual old custody path reaches acceptance.
 * It is not allocated in advance of a pending schedule release. */
export type CancelExistingCustomerOriginal = CommonOriginal &
  (
    | {
        readonly kind: "native";
        readonly original: {
          readonly id: string;
          readonly association: Association;
          readonly prePeriodEnd: string;
          readonly createdAt: string;
          readonly updatedAt: string;
        };
        readonly parentRelease: {
          readonly admissionRef: string;
          readonly dispatchReceiptRef: string;
        } | null;
      }
    | {
        readonly kind: "pending-release";
        readonly original: {
          readonly desired: {
            readonly organizationId: string;
            readonly reference: string;
            readonly expectedSubscriptionRef: string;
            readonly kind: "cancel";
            readonly cancelAtPeriodEnd?: true;
          };
          readonly target: SubscriptionPlanTarget;
          readonly pendingReference: string;
          readonly scheduleId: string;
          readonly effectiveAt: string;
          readonly previousSlotGeneration: number;
          readonly createdAt: string;
          readonly stepCreatedAt: string;
        };
        readonly parentRelease: null;
      }
  );
type Options = Parameters<typeof createFinancialRetainedR1Store>[0] & { readonly rawSql: Sql };
export type CancelExecutionData = {
  readonly qualification: "unqualified-private-cancel-sql-data-only";
  readonly original: CancelExistingCustomerOriginal;
  readonly status: "own-phase-ack-data" | "held-original-get-only";
  readonly phase:
    | "cancel-native-accepted"
    | "cancel-native-first-dispatch"
    | "cancel-release-accepted"
    | "cancel-release-step-prepared"
    | "cancel-release-first-dispatch"
    | null;
  readonly observation: unknown;
};
function invalid(): never {
  throw new SqlError("invalid", "closed original cancel DATA mismatch");
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
// Financial-owned finite Customer chain: same ordered376 non-parenthesis tokens
// as the frozen original. Only AND/OR grouping differs; no Root/helper edits.
const CANCEL_CUSTOMER_CHAIN_MATCH = `(NOT EXISTS(SELECT 1 FROM financial_customer_history_entries e
 LEFT JOIN financial_customer_history_receipts receipt ON receipt.receipt_ref=e.expected_history_receipt_ref
 LEFT JOIN financial_customer_history_receipts previous ON previous.receipt_ref=e.previous_history_receipt_ref
 LEFT JOIN customer_entry_matches valid ON valid.history_ref=e.history_ref AND valid.entry_ref=e.entry_ref
 WHERE e.history_ref=cv.history_ref AND ((((e.journal_sequence>hh.journal_sequence OR (receipt.receipt_ref IS NULL OR receipt.all_rows_match IS NOT 1)) OR ((receipt.entry_ref IS NOT e.entry_ref OR receipt.attempt_ref IS NOT e.coupling_attempt_ref) OR (receipt.history_ref IS NOT e.history_ref OR receipt.journal_sequence IS NOT e.journal_sequence))) OR (((receipt.evidence_kind IS NOT e.evidence_kind OR receipt.command_org_id IS NOT e.command_org_id) OR (receipt.l1_receipt_ref IS NOT e.l1_receipt_ref OR receipt.dispatch_receipt_ref IS NOT e.dispatch_receipt_ref)) OR ((receipt.custody_receipt_ref IS NOT e.custody_receipt_ref OR receipt.original_org_origin IS NOT cv.original_org_origin) OR (receipt.realm_registration IS NOT cv.realm_registration OR receipt.realm_incarnation IS NOT cv.realm_incarnation)))) OR ((e.journal_sequence>0 AND ((previous.receipt_ref IS NULL OR previous.history_ref IS NOT e.history_ref) OR ((previous.journal_sequence IS NOT e.journal_sequence-1 OR receipt.previous_history_receipt_ref IS NOT previous.receipt_ref) OR (receipt.previous_entry_ref IS NOT previous.entry_ref OR receipt.previous_journal_sequence IS NOT previous.journal_sequence)))) OR valid.entry_ref IS NULL))) AND ((EXISTS(SELECT 1 FROM financial_customer_history_entries e JOIN financial_customer_history_receipts receipt ON receipt.entry_ref=e.entry_ref
 WHERE e.history_ref=cv.history_ref AND e.journal_sequence=0 AND e.evidence_kind='genesis' AND receipt.receipt_ref=cv.expected_receipt_ref) AND (SELECT count(*) FROM financial_customer_history_entries e WHERE e.history_ref=cv.history_ref)=hh.journal_sequence+1) AND EXISTS(SELECT 1 FROM financial_customer_history_entries e JOIN financial_customer_history_receipts receipt ON receipt.entry_ref=e.entry_ref
 WHERE e.entry_ref=hh.last_entry_ref AND e.history_ref=cv.history_ref AND e.journal_sequence=hh.journal_sequence
 AND receipt.receipt_ref=hh.last_expected_receipt_ref AND receipt.all_rows_match=1)))`;
// Same actual adapter management predicate, including its release-only exception.
const RELEASED = `EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots s
      JOIN stripe_billing_plan_changes c ON c.org_id=s.org_id AND c.reference=s.reference
      JOIN stripe_billing_plan_change_steps step ON step.org_id=c.org_id AND step.reference=c.reference
      WHERE s.org_id=? AND c.kind='cancel' AND c.subscription_id IS ?
        AND json_extract(c.frozen_json,'$.custodyRequestKeyDigest')=?
        AND step.step='release' AND step.state='verified')`;
const MANAGEMENT = `NOT EXISTS(SELECT 1 FROM stripe_billing_customer_commands WHERE org_id=? AND state<>'verified') AND NOT EXISTS(SELECT 1 FROM stripe_subscription_checkout_intents WHERE org_id=? AND state IN ('prepared','dispatched','session_known')) AND (NOT EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=?) OR ${RELEASED})`;
const NATIVE_INSERT = `INSERT OR IGNORE INTO stripe_subscription_cancellation_intents
       (id,org_id,request_key_digest,fingerprint,subscription_id,customer_id,livemode,plan_key,
        pricing_revision,price_id,price_amount_minor,included_minor,pre_period_end,state,created_at,updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?
       WHERE EXISTS (SELECT 1 FROM stripe_billing_subscriptions WHERE org_id = ? AND subscription_id = ?
         AND customer_id = ? AND cancel_at_period_end = 0 AND status NOT IN ('canceled','incomplete_expired'))
       AND NOT EXISTS (SELECT 1 FROM stripe_subscription_cancellation_intents WHERE subscription_id = ? AND state IN ('prepared','dispatched'))
       AND (${MANAGEMENT})`;
const NATIVE_DISPATCH = `UPDATE stripe_subscription_cancellation_intents SET state = 'dispatched', updated_at = ?
       WHERE id = ? AND state = 'prepared' AND EXISTS
         (SELECT 1 FROM stripe_billing_subscriptions WHERE org_id = ? AND subscription_id = ?
            AND customer_id = ? AND cancel_at_period_end = 0 AND status NOT IN ('canceled','incomplete_expired'))
         AND (${MANAGEMENT})`;
const PLAN_INSERT = `INSERT INTO stripe_billing_plan_changes(org_id,reference,fingerprint,kind,expected_subscription_ref,subscription_id,expected_generation,desired_json,frozen_json,state,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL,?)`;
const SLOT = `INSERT INTO stripe_billing_plan_change_slots(org_id,reference,generation) VALUES(?,?,?) ON CONFLICT(org_id) DO UPDATE SET reference=excluded.reference,generation=excluded.generation`;
const STEP = `INSERT OR IGNORE INTO stripe_billing_plan_change_steps(org_id,reference,step,request_json,idempotency_key,state,remote_id,response_json,created_at,dispatched_at,verified_at) VALUES(?,?,?,?,?,'prepared',NULL,NULL,?,NULL,NULL)`;
const CLAIM =
  "UPDATE stripe_billing_plan_change_steps SET state='dispatched',dispatched_at=? WHERE org_id=? AND reference=? AND step=? AND state='prepared'";
const TARGET_FENCE = `EXISTS(SELECT 1 FROM stripe_billing_associations a JOIN stripe_billing_subscriptions s ON s.org_id=a.org_id AND s.subscription_id=a.subscription_id JOIN stripe_billing_customers customer ON customer.org_id=a.org_id AND customer.customer_id=a.customer_id
        WHERE a.org_id=? AND a.subscription_id=? AND a.customer_id=? AND a.livemode=0 AND a.association_generation=? AND a.association_generation=(SELECT MAX(association_generation) FROM stripe_billing_associations WHERE org_id=?))
        AND NOT EXISTS(SELECT 1 FROM stripe_subscription_checkout_intents WHERE org_id=? AND state IN ('prepared','dispatched','session_known'))
        AND NOT EXISTS(SELECT 1 FROM stripe_billing_customer_commands WHERE org_id=? AND state<>'verified')
        AND NOT EXISTS(SELECT 1 FROM stripe_subscription_cancellation_intents cancellation WHERE org_id=? AND subscription_id=?
          AND NOT EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots slot JOIN stripe_billing_plan_changes c ON c.org_id=slot.org_id AND c.reference=slot.reference
            JOIN stripe_billing_plan_change_steps step ON step.org_id=c.org_id AND step.reference=c.reference
            WHERE slot.org_id=cancellation.org_id AND c.kind='cancel' AND c.subscription_id=cancellation.subscription_id
              AND json_extract(c.frozen_json,'$.custodyRequestKeyDigest')=cancellation.request_key_digest AND step.step='release' AND step.state='verified'))`;

/** Fixed SQL DATA compiler only. Original native GET/ready/Clock/term proof, release
 * reconciliation and the old sole POST sites remain owned by the unchanged public paths.
 * No native object/callback, caller SQL, NEW Boolean, or provider command is accepted. */
export function createCancelExistingCustomerData(
  options: Options,
  original: CancelExistingCustomerOriginal,
) {
  const q = capture(original);
  if (q.kind !== "native" && q.kind !== "pending-release") invalid();
  const S = options.sql,
    R = options.rawSql,
    epoch = options.writerEpoch;
  // The actual plan core fingerprints the complete enumerable factory realm, including
  // the retained Price qualification list; never invent a reduced three-field substitute.
  const planRealm = capture(options.realm);
  if (
    Object.keys(q).sort().join() !==
    "acceptanceAttemptRef,acceptanceReceiptRef,admissionRef,consent,customer,dispatchAttemptRef,dispatchReceiptRef,input,kind,original,parentRelease,preparationAttemptRef,preparationReceiptRef,r1"
  )
    invalid();
  if (Object.keys(q.input).sort().join() !== "expectedSubscriptionRef,organizationId,reference")
    invalid();
  const methods = [S, R].flatMap((port) =>
    ["query", "run", "batch"].map((name) => ({
      port,
      name,
      descriptor: Object.getOwnPropertyDescriptor(port, name),
    })),
  );
  for (const x of methods)
    if (!x.descriptor || !("value" in x.descriptor) || typeof x.descriptor.value !== "function")
      invalid();
  const rQuery = Object.getOwnPropertyDescriptor(R, "query")!,
    rBatch = Object.getOwnPropertyDescriptor(R, "batch")!;
  const contextJson = JSON.stringify(q);
  if (
    new TextEncoder().encode(contextJson).length > 2097152 ||
    new TextEncoder().encode(JSON.stringify(q.r1)).length > 98304
  )
    invalid();
  const retained = createFinancialRetainedR1Store(options),
    customer = createCustomerTrackedExecutionData(R);
  let held = false;
  const started = new Set<string>(),
    acknowledged = new Set<string>();
  function stable() {
    assertMoneyCutoverSqlBackingOrigin(S, { rawSql: R, writerEpoch: epoch });
    for (const x of methods) {
      const now = Object.getOwnPropertyDescriptor(x.port, x.name);
      if (!now || !("value" in now) || now.value !== x.descriptor!.value) invalid();
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
    const rows = capture(
      await observed(
        () => Reflect.apply(rQuery.value, R, [sql, params]) as Promise<readonly Row[]>,
      ),
    );
    if (
      !Array.isArray(rows) ||
      rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))
    )
      invalid();
    return rows;
  }
  const readRows = () =>
    query(
      `SELECT a.*,h.receipt_ref,h.attempt_ref,h.phase,h.previous_receipt_ref,h.all_rows_match,h.context_json AS history_context_json,h.original_json AS history_original_json,h.fingerprint AS history_fingerprint,h.stripe_key AS history_stripe_key,h.recorded_at,h.command_updated_at
    FROM financial_cancel_admissions a JOIN financial_cancel_history_receipts h ON h.admission_ref=a.admission_ref
    WHERE a.org_id=? AND a.reference=? AND a.stage=? ORDER BY h.phase`,
      [q.input.organizationId, q.input.reference, q.kind],
    );
  function data(
    status: CancelExecutionData["status"],
    phase: CancelExecutionData["phase"],
    observation: unknown,
  ): CancelExecutionData {
    return Object.freeze({
      qualification: "unqualified-private-cancel-sql-data-only",
      original: q,
      status,
      phase,
      observation: capture(observation),
    });
  }
  async function hold(): Promise<CancelExecutionData> {
    held = true;
    try {
      return data("held-original-get-only", null, await readRows());
    } catch {
      return data("held-original-get-only", null, { status: "unknown-read-or-port-drift" });
    }
  }
  async function payload(at: string | null) {
    const r = q.r1.original,
      e = r.economic,
      action = parseSharedFinancialAction(r.c0.selection.action.body);
    if (
      action.kind !== "cancel" ||
      e.kind !== "cancel" ||
      action.organizationId !== q.input.organizationId ||
      action.reference !== q.input.reference ||
      action.expectedSubscriptionRef !== q.input.expectedSubscriptionRef ||
      e.expectedSubscriptionRef !== q.input.expectedSubscriptionRef ||
      e.cancelAtPeriodEnd !== true ||
      e.targetSubscriptionId === "" ||
      !Number.isSafeInteger(e.targetGeneration) ||
      e.targetGeneration < 0
    )
      invalid();
    if (
      q.customer.phase !== "N" ||
      q.customer.writerEpoch !== epoch ||
      r.scopeRealm.writerEpoch !== epoch ||
      q.customer.nativeOriginal.organizationId !== q.input.organizationId ||
      r.c0.selection.customer.idempotencyKey !== q.customer.nativeOriginal.commandKey ||
      r.c0.selection.customer.requestFingerprint !== q.customer.nativeOriginal.fingerprint ||
      q.consent.challengeRef !== q.r1.key.challengeRef ||
      q.consent.actionKind !== "cancel" ||
      q.consent.actionRef !== q.input.reference ||
      q.consent.requestFingerprint !== r.c0.challenge.requestFingerprint
    )
      invalid();
    compileCustomerPhase(q.customer);
    const refs = [
      q.admissionRef,
      q.acceptanceAttemptRef,
      q.acceptanceReceiptRef,
      q.dispatchAttemptRef,
      q.dispatchReceiptRef,
      ...(q.kind === "pending-release" ? [q.preparationAttemptRef, q.preparationReceiptRef] : []),
    ];
    if (
      refs.some((x) => typeof x !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/u.test(x)) ||
      new Set(refs).size !== refs.length
    )
      invalid();
    if (at !== null) iso(at);
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
    const requestKey = (
      await observed(() => canonicalDigest([q.input.organizationId, q.input.reference]))
    ).slice(7);
    const expectedRef = `sra_${(await observed(() => canonicalDigest(["takoserver-subscription-association-ref:v1", q.input.organizationId, e.targetSubscriptionId, q.customer.nativeOriginal.customerId, false]))).slice(7)}`;
    if (expectedRef !== q.input.expectedSubscriptionRef) invalid();
    let fingerprint: string,
      stripeKey: string,
      originalJson: string,
      createdAt: string,
      updatedAt: string,
      desiredJson: string | null = null,
      frozenJson: string | null = null;
    let releaseProof: {
      readonly responseJson: string;
      readonly releasedAt: string;
      readonly effectiveAt: string;
      readonly revocationRequired: boolean;
    } | null = null;
    if (q.kind === "native") {
      const n = q.original,
        a = n.association;
      if (
        Object.keys(a).sort().join() !==
        "customerId,includedMinor,livemode,organizationId,planKey,priceAmountMinor,priceId,pricingRevision,sessionId,subscriptionId"
      )
        invalid();
      if (
        Object.keys(n).sort().join() !== "association,createdAt,id,prePeriodEnd,updatedAt" ||
        !/^smc_[A-Za-z0-9-]{1,240}$/u.test(n.id) ||
        a.organizationId !== q.input.organizationId ||
        a.subscriptionId !== e.targetSubscriptionId ||
        a.customerId !== q.customer.nativeOriginal.customerId ||
        a.livemode !== false ||
        !Number.isSafeInteger(a.priceAmountMinor) ||
        a.priceAmountMinor <= 0 ||
        !Number.isSafeInteger(a.includedMinor) ||
        a.includedMinor < 0 ||
        q.preparationAttemptRef !== null ||
        q.preparationReceiptRef !== null
      )
        invalid();
      for (const t of [n.prePeriodEnd, n.createdAt, n.updatedAt]) iso(t);
      if ((e.branch === "legacy") !== (q.parentRelease === null)) invalid();
      if (e.branch === "legacy" && (e.pendingReference !== null || e.scheduleId !== null))
        invalid();
      if (q.parentRelease) {
        if (Object.keys(q.parentRelease).sort().join() !== "admissionRef,dispatchReceiptRef")
          invalid();
        const rows = await query(
          `SELECT step.response_json,c.frozen_json FROM financial_cancel_admissions parent
          JOIN stripe_billing_plan_changes c ON c.org_id=parent.org_id AND c.reference=parent.reference
          JOIN stripe_billing_plan_change_steps step ON step.org_id=c.org_id AND step.reference=c.reference AND step.step='release'
          WHERE parent.admission_ref=? AND parent.stage='pending-release' AND step.state='verified'`,
          [q.parentRelease.admissionRef],
        );
        if (
          rows.length !== 1 ||
          typeof rows[0]?.response_json !== "string" ||
          typeof rows[0]?.frozen_json !== "string"
        )
          invalid();
        const response = capture(JSON.parse(rows[0].response_json)) as Record<string, unknown>,
          frozen = capture(JSON.parse(rows[0].frozen_json)) as Record<string, unknown>;
        if (
          !Number.isSafeInteger(response.released_at) ||
          Number(response.released_at) <= 0 ||
          typeof frozen.effectiveAt !== "string"
        )
          invalid();
        const releasedAt = new Date(Number(response.released_at) * 1000).toISOString();
        iso(releasedAt);
        iso(frozen.effectiveAt);
        releaseProof = {
          responseJson: rows[0].response_json,
          releasedAt,
          effectiveAt: frozen.effectiveAt,
          revocationRequired: releasedAt < frozen.effectiveAt,
        };
      }
      fingerprint = (
        await observed(() =>
          canonicalDigest([
            q.input.organizationId,
            a.subscriptionId,
            a.customerId,
            a.livemode,
            a.planKey,
            a.pricingRevision,
            a.priceId,
            a.priceAmountMinor,
            a.includedMinor,
            n.prePeriodEnd,
            "cancel_at_period_end",
          ]),
        )
      ).slice(7);
      stripeKey = `takoserver-subscription-cancel:${n.id}`;
      originalJson = JSON.stringify(n);
      createdAt = n.createdAt;
      updatedAt = at ?? n.updatedAt;
    } else {
      const n = q.original,
        t = n.target;
      if (
        Object.keys(n).sort().join() !==
          "createdAt,desired,effectiveAt,pendingReference,previousSlotGeneration,scheduleId,stepCreatedAt,target" ||
        Object.keys(t).sort().join() !==
          "billingCycleAnchor,cancelAtPeriodEnd,generation,originalEffectiveAt,periodEnd,periodStart,scheduleId,subscriptionRef,terms,unresolvedSettlement" ||
        Object.keys(t.terms).sort().join() !==
          "customerId,includedMinor,organizationId,planKey,priceAmountMinor,priceId,pricingRevision,subscriptionId" ||
        typeof t.cancelAtPeriodEnd !== "boolean" ||
        typeof t.unresolvedSettlement !== "boolean" ||
        !Number.isSafeInteger(t.billingCycleAnchor)
      )
        invalid();
      if (
        e.branch !== "pending-plan-change" ||
        q.parentRelease !== null ||
        e.pendingReference !== n.pendingReference ||
        e.scheduleId !== n.scheduleId ||
        t.subscriptionRef !== q.input.expectedSubscriptionRef ||
        t.generation !== e.targetGeneration ||
        t.terms.organizationId !== q.input.organizationId ||
        t.terms.subscriptionId !== e.targetSubscriptionId ||
        t.terms.customerId !== q.customer.nativeOriginal.customerId ||
        t.scheduleId !== n.scheduleId ||
        !Number.isSafeInteger(n.previousSlotGeneration) ||
        n.previousSlotGeneration < 1 ||
        !q.preparationAttemptRef ||
        !q.preparationReceiptRef
      )
        invalid();
      for (const v of [
        n.createdAt,
        n.stepCreatedAt,
        n.effectiveAt,
        t.originalEffectiveAt,
        t.periodStart,
        t.periodEnd,
      ])
        iso(v);
      const desired = n.desired,
        fields = Object.keys(desired).sort().join();
      if (
        (fields !== "expectedSubscriptionRef,kind,organizationId,reference" &&
          fields !== "cancelAtPeriodEnd,expectedSubscriptionRef,kind,organizationId,reference") ||
        desired.organizationId !== q.input.organizationId ||
        desired.reference !== q.input.reference ||
        desired.expectedSubscriptionRef !== q.input.expectedSubscriptionRef ||
        desired.kind !== "cancel" ||
        ("cancelAtPeriodEnd" in desired && desired.cancelAtPeriodEnd !== true)
      )
        invalid();
      if (
        planRealm.accountId !== r.scopeRealm.accountId ||
        planRealm.mode !== r.scopeRealm.mode ||
        planRealm.billingAuthority !== r.scopeRealm.billingAuthority ||
        planRealm.financialRealm !== r.scopeRealm.financialRealm ||
        planRealm.livemode !== false
      )
        invalid();
      desiredJson = canonicalJson(desired);
      frozenJson = canonicalJson({
        target: t,
        pendingReference: n.pendingReference,
        scheduleId: n.scheduleId,
        effectiveAt: n.effectiveAt,
        custodyRequestKeyDigest: requestKey,
      });
      fingerprint = await observed(() => canonicalDigest([planRealm, desired]));
      stripeKey = `takos-plan-${await observed(() => canonicalDigest([planRealm, { org: q.input.organizationId, reference: q.input.reference, step: "release" }]))}`;
      originalJson = JSON.stringify(n);
      createdAt = n.createdAt;
      updatedAt = at ?? n.createdAt;
    }
    // A's existing bounded selection retains these six original metadata fields only.
    // The full body stays in immutable R1 command/receipt custody and its validating reader.
    const termsMetadataJson = canonicalJson({
      ref: r.selectedTerms.ref,
      digest: r.selectedTerms.digest,
      mediaType: r.selectedTerms.mediaType,
      locale: r.selectedTerms.locale,
      bodyByteLength: r.selectedTerms.bodyByteLength,
      digestRecipe: r.selectedTerms.digestRecipe,
    });
    return {
      q,
      contextJson,
      r1Json: canonicalJson(q.r1),
      c0Json: canonicalJson({ ...r.c0, scope: r.scopeRealm }),
      epoch,
      at,
      requestKey,
      fingerprint,
      stripeKey,
      originalJson,
      createdAt,
      updatedAt,
      desiredJson,
      frozenJson,
      releaseProof,
      termsMetadataJson,
    };
  }
  type Payload = Awaited<ReturnType<typeof payload>>;
  function ctes(current: string) {
    return `WITH v(data) AS (VALUES (?)), customer_match_scope(history_ref) AS MATERIALIZED (SELECT ${V("q.customer.history.historyRef")} FROM v), ${CUSTOMER_MATCH_CTES}, current_cancel_proof AS MATERIALIZED (${current})`;
  }
  function proof(p: Payload) {
    const g = guard(q.consent, q.input.organizationId);
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
      AND json_extract(c.selection_json,'$.selectedTerms') IS ${V("termsMetadataJson")}
      AND NOT EXISTS(SELECT 1 FROM financial_payer_grant_revocations revoked WHERE revoked.grant_ref=g.grant_ref)
      AND EXISTS(SELECT 1 ${CUSTOMER_COVERAGE_JOINS}
      JOIN financial_customer_history_entries e ON e.history_ref=cv.history_ref AND e.transition_ref IS ${V("q.customer.custodyReceiptRef")}
      JOIN financial_customer_history_receipts h ON h.entry_ref=e.entry_ref AND h.receipt_ref IS ${V("q.customer.historyReceiptRef")}
      WHERE cv.history_ref IS ${V("q.customer.history.historyRef")} AND e.evidence_kind='customer-verified-binding'
      AND e.original_command_key IS ${V("q.customer.nativeOriginal.commandKey")} AND e.command_org_id=c.organization_id
      AND e.command_after_customer_id IS ${V("q.customer.nativeOriginal.customerId")} AND e.entry_ref IS ${V("q.customer.entryRef")}
      AND ${CUSTOMER_COVERAGE_MATCH} AND ${CANCEL_CUSTOMER_CHAIN_MATCH} AND ${CUSTOMER_CURRENT_CUSTODY_MATCH})`;
    return { sql: `${sql} AND (${business(p)})`, params: [JSON.stringify(p), ...g.params] };
  }

  function business(_p: Payload): string {
    const common = `EXISTS(SELECT 1 FROM stripe_billing_associations a JOIN stripe_billing_subscriptions s ON s.org_id=a.org_id AND s.subscription_id=a.subscription_id
      JOIN stripe_billing_customers b ON b.org_id=a.org_id AND b.customer_id=a.customer_id CROSS JOIN v
      WHERE a.org_id IS ${V("q.input.organizationId")} AND a.subscription_id IS ${V("q.r1.original.economic.targetSubscriptionId")}
      AND a.customer_id IS ${V("q.customer.nativeOriginal.customerId")} AND a.livemode IS 0
      AND a.association_generation IS ${V("q.r1.original.economic.targetGeneration")}
      AND a.association_generation=(SELECT MAX(association_generation) FROM stripe_billing_associations WHERE org_id=a.org_id))`;
    if (q.kind === "pending-release")
      return `${common} AND EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots slot
      JOIN stripe_billing_plan_changes own ON own.org_id=slot.org_id AND own.reference=slot.reference
      JOIN stripe_billing_plan_changes previous ON previous.org_id=own.org_id AND previous.reference=${V("q.original.pendingReference")}
      JOIN stripe_billing_plan_change_steps created ON created.org_id=previous.org_id AND created.reference=previous.reference AND created.step='create' CROSS JOIN v
      WHERE own.org_id IS ${V("q.input.organizationId")} AND own.reference IS ${V("q.input.reference")}
      AND own.kind='cancel' AND own.state='pending' AND own.fingerprint IS ${V("fingerprint")} AND own.desired_json IS ${V("desiredJson")} AND own.frozen_json IS ${V("frozenJson")}
      AND own.expected_generation IS ${V("q.r1.original.economic.targetGeneration")} AND slot.generation=${V("q.original.previousSlotGeneration")}+1
      AND previous.kind='plan-change' AND previous.state='verified' AND previous.subscription_id IS own.subscription_id
      AND json_extract(previous.frozen_json,'$.effectiveAt') IS ${V("q.original.effectiveAt")}
      AND created.state='verified' AND created.remote_id IS ${V("q.original.scheduleId")})`;
    const nMatch = `EXISTS(SELECT 1 FROM stripe_subscription_cancellation_intents k CROSS JOIN v
      WHERE k.id IS ${V("q.original.id")} AND k.org_id IS ${V("q.input.organizationId")} AND k.request_key_digest IS ${V("requestKey")}
      AND k.fingerprint IS ${V("fingerprint")} AND k.livemode IS 0
      AND k.subscription_id IS ${V("q.original.association.subscriptionId")} AND k.customer_id IS ${V("q.original.association.customerId")}
      AND k.plan_key IS ${V("q.original.association.planKey")} AND k.pricing_revision IS ${V("q.original.association.pricingRevision")}
      AND k.price_id IS ${V("q.original.association.priceId")} AND k.price_amount_minor IS ${V("q.original.association.priceAmountMinor")}
      AND k.included_minor IS ${V("q.original.association.includedMinor")} AND k.pre_period_end IS ${V("q.original.prePeriodEnd")}
      AND k.created_at IS ${V("q.original.createdAt")} AND k.updated_at IS ${V("updatedAt")})`;
    const aMatch = `EXISTS(SELECT 1 FROM stripe_billing_associations a CROSS JOIN v WHERE a.subscription_id IS ${V("q.original.association.subscriptionId")}
      AND a.org_id IS ${V("q.input.organizationId")} AND a.customer_id IS ${V("q.original.association.customerId")} AND a.livemode IS 0
      AND a.plan_key IS ${V("q.original.association.planKey")} AND a.pricing_revision IS ${V("q.original.association.pricingRevision")}
      AND a.price_id IS ${V("q.original.association.priceId")} AND a.price_amount_minor IS ${V("q.original.association.priceAmountMinor")}
      AND a.included_minor IS ${V("q.original.association.includedMinor")} AND a.session_id IS ${V("q.original.association.sessionId")})`;
    if (!q.parentRelease)
      return `${common} AND ${aMatch} AND ${nMatch} AND NOT EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots CROSS JOIN v WHERE org_id IS ${V("q.input.organizationId")})`;
    return `${common} AND ${aMatch} AND ${nMatch} AND EXISTS(SELECT 1 FROM financial_cancel_admissions parent
      JOIN financial_cancel_history_receipts h ON h.admission_ref=parent.admission_ref AND h.receipt_ref=${V("q.parentRelease.dispatchReceiptRef")}
      JOIN stripe_billing_plan_changes c ON c.org_id=parent.org_id AND c.reference=parent.reference
      JOIN stripe_billing_plan_change_steps step ON step.org_id=c.org_id AND step.reference=c.reference AND step.step='release'
      JOIN stripe_billing_plan_change_slots slot ON slot.org_id=c.org_id AND slot.reference=c.reference CROSS JOIN v
      WHERE (((((parent.admission_ref IS ${V("q.parentRelease.admissionRef")} AND parent.stage='pending-release') AND (h.phase='cancel-release-first-dispatch' AND parent.org_id IS ${V("q.input.organizationId")})) AND ((parent.reference IS ${V("q.input.reference")} AND parent.r1_json IS ${V("r1Json")}) AND (parent.customer_custody_ref IS ${V("q.customer.custodyReceiptRef")} AND (parent.customer_history_receipt_ref IS ${V("q.customer.historyReceiptRef")} AND parent.grant_ref IS ${V("q.consent.grantRef")})))) AND (((h.all_rows_match IS 1 AND h.context_json=parent.context_json) AND (c.kind='cancel' AND (c.frozen_json=parent.frozen_json AND c.desired_json=parent.desired_json))) AND ((c.fingerprint=parent.fingerprint AND c.expected_subscription_ref IS ${V("q.input.expectedSubscriptionRef")}) AND (c.subscription_id IS ${V("q.original.association.subscriptionId")} AND (json_extract(c.frozen_json,'$.custodyRequestKeyDigest') IS ${V("requestKey")} AND json_extract(c.frozen_json,'$.pendingReference') IS ${V("q.r1.original.economic.pendingReference")}))))) AND ((((step.state='verified' AND step.request_json IS '{"preserve_cancel_date":"true"}') AND (step.idempotency_key=parent.stripe_key AND step.remote_id IS ${V("q.r1.original.economic.scheduleId")})) AND ((json_extract(step.response_json,'$.id')=step.remote_id AND json_extract(step.response_json,'$.status')='released') AND (json_extract(step.response_json,'$.livemode') IS 0 AND (json_extract(step.response_json,'$.customer') IS ${V("q.customer.nativeOriginal.customerId")} AND json_extract(step.response_json,'$.released_subscription') IS ${V("q.original.association.subscriptionId")})))) AND (((json_extract(step.response_json,'$.subscription') IS NULL AND json_extract(step.response_json,'$.application') IS NULL) AND (json_extract(step.response_json,'$.on_behalf_of') IS NULL AND (json_extract(step.response_json,'$.transfer_data') IS NULL AND json_extract(step.response_json,'$.account') IS NULL))) AND ((typeof(json_extract(step.response_json,'$.released_at'))='integer' AND json_extract(step.response_json,'$.released_at')>0) AND (step.response_json IS ${V("releaseProof.responseJson")} AND (json_extract(c.frozen_json,'$.effectiveAt') IS ${V("releaseProof.effectiveAt")} AND (${V("releaseProof.revocationRequired")} IS 0
        OR EXISTS(SELECT 1 FROM stripe_billing_subscription_term_revocations revoke WHERE revoke.subscription_id=c.subscription_id
          AND revoke.effective_at IS ${V("releaseProof.effectiveAt")} AND revoke.org_id=c.org_id AND revoke.reference=c.reference
          AND revoke.released_at IS ${V("releaseProof.releasedAt")})))))))))`;
  }
  function statements(p: Payload, phase: NonNullable<CancelExecutionData["phase"]>) {
    const full = proof(p),
      prefix = ctes(full.sql),
      writes: SqlStatement[] = [],
      expected: number[] = [],
      ids: string[] = [];
    const add = (statement: SqlStatement, count = 1) => {
      writes.push(statement);
      expected.push(count);
    };
    const check = (condition: string, params: readonly (string | number | null)[] = []) => {
      const id = `plan_guard_${crypto.randomUUID()}`;
      ids.push(id);
      add({
        sql: `INSERT INTO wallet_allocation_guards (id,valid) VALUES (?,CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
        params: [id, ...params],
      });
    };
    const org = q.input.organizationId,
      ref = q.input.reference;
    const accepted = phase.endsWith("-accepted"),
      preparation = phase === "cancel-release-step-prepared";
    if (q.kind === "native") {
      const n = q.original,
        a = n.association;
      const shared = [org, org, org, org, a.subscriptionId, p.requestKey];
      if (accepted)
        add({
          sql: NATIVE_INSERT,
          params: [
            n.id,
            org,
            p.requestKey,
            p.fingerprint,
            a.subscriptionId,
            a.customerId,
            Number(a.livemode),
            a.planKey,
            a.pricingRevision,
            a.priceId,
            a.priceAmountMinor,
            a.includedMinor,
            n.prePeriodEnd,
            n.createdAt,
            n.updatedAt,
            org,
            a.subscriptionId,
            a.customerId,
            a.subscriptionId,
            ...shared,
          ],
        });
      else
        add({
          sql: NATIVE_DISPATCH,
          params: [p.updatedAt, n.id, org, a.subscriptionId, a.customerId, ...shared],
        });
    } else {
      const n = q.original,
        t = n.target;
      const fenceParams = [
        org,
        t.terms.subscriptionId,
        t.terms.customerId,
        t.generation,
        org,
        org,
        org,
        org,
        t.terms.subscriptionId,
      ];
      if (accepted) {
        check(TARGET_FENCE, fenceParams);
        check(
          "EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=? AND reference=? AND generation=?)",
          [org, n.pendingReference, n.previousSlotGeneration],
        );
        add({
          sql: PLAN_INSERT,
          params: [
            org,
            ref,
            p.fingerprint,
            "cancel",
            q.input.expectedSubscriptionRef,
            t.terms.subscriptionId,
            t.generation,
            p.desiredJson,
            p.frozenJson,
            n.createdAt,
          ],
        });
        add({ sql: SLOT, params: [org, ref, n.previousSlotGeneration + 1] });
      } else if (preparation)
        add({
          sql: STEP,
          params: [
            org,
            ref,
            "release",
            canonicalJson({ preserve_cancel_date: "true" }),
            p.stripeKey,
            n.stepCreatedAt,
          ],
        });
      else {
        check(TARGET_FENCE, fenceParams);
        check(
          "EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=? AND reference=?)",
          [org, ref],
        );
        add({ sql: CLAIM, params: [p.at, org, ref, "release"] });
        check("changes()=1");
      }
    }
    if (accepted)
      add({
        sql: `${prefix} INSERT INTO financial_cancel_admissions
      (admission_ref,org_id,reference,stage,branch,original_json,context_json,r1_json,fingerprint,stripe_key,request_key_digest,desired_json,frozen_json,native_intent_id,plan_org_id,plan_reference,customer_custody_ref,customer_history_receipt_ref,r1_ref,r1_receipt_ref,grant_ref,consent_receipt_ref,acceptance_receipt_ref,preparation_receipt_ref,dispatch_receipt_ref,parent_release_ref,parent_release_receipt_ref,writer_epoch,created_at)
      SELECT ${["q.admissionRef", "q.input.organizationId", "q.input.reference", "q.kind", "q.r1.original.economic.branch", "originalJson", "contextJson", "r1Json", "fingerprint", "stripeKey", "requestKey", "desiredJson", "frozenJson"].map(V).join(",")},${q.kind === "native" ? V("q.original.id") : "NULL"},${q.kind === "pending-release" ? V("q.input.organizationId") : "NULL"},${q.kind === "pending-release" ? V("q.input.reference") : "NULL"},${["q.customer.custodyReceiptRef", "q.customer.historyReceiptRef", "q.r1.key.r1Ref", "q.r1.r1ReceiptRef", "q.consent.grantRef", "q.consent.receiptRef", "q.acceptanceReceiptRef", "q.preparationReceiptRef", "q.dispatchReceiptRef", "q.parentRelease.admissionRef", "q.parentRelease.dispatchReceiptRef", "epoch", "createdAt"].map(V).join(",")}
      FROM v WHERE changes()=1 AND EXISTS(SELECT 1 FROM current_cancel_proof)`,
        params: full.params,
      });
    const receipt = accepted
      ? q.acceptanceReceiptRef
      : preparation
        ? q.preparationReceiptRef
        : q.dispatchReceiptRef;
    const attempt = accepted
      ? q.acceptanceAttemptRef
      : preparation
        ? q.preparationAttemptRef
        : q.dispatchAttemptRef;
    const previous = accepted
      ? null
      : preparation || q.kind === "native"
        ? q.acceptanceReceiptRef
        : q.preparationReceiptRef;
    const recordedAt = accepted
      ? p.createdAt
      : preparation
        ? q.kind === "pending-release"
          ? q.original.stepCreatedAt
          : invalid()
        : p.at;
    add({
      sql: `${prefix} INSERT INTO financial_cancel_history_receipts
      (receipt_ref,attempt_ref,admission_ref,phase,previous_receipt_ref,org_id,reference,original_json,context_json,fingerprint,stripe_key,recorded_at,command_updated_at,all_rows_match)
      SELECT ?,?,?,?,?,?,?,${V("originalJson")},${V("contextJson")},${V("fingerprint")},${V("stripeKey")},?,?,
      CASE WHEN changes()=1 AND current_match.matched IS 1 AND EXISTS(SELECT 1 FROM financial_cancel_admissions a CROSS JOIN v
        WHERE a.admission_ref IS ${V("q.admissionRef")} AND a.context_json IS ${V("contextJson")} AND a.original_json IS ${V("originalJson")}
        AND a.fingerprint IS ${V("fingerprint")} AND a.stripe_key IS ${V("stripeKey")}) THEN 1 ELSE 0 END
      FROM v LEFT JOIN (SELECT 1 AS matched FROM current_cancel_proof LIMIT 1) current_match ON 1`,
      params: [
        ...full.params,
        receipt,
        attempt,
        q.admissionRef,
        phase,
        previous,
        org,
        ref,
        recordedAt,
        preparation && q.kind === "pending-release" ? q.original.stepCreatedAt : p.updatedAt,
      ],
    });
    if (ids.length)
      add(
        {
          sql: `DELETE FROM wallet_allocation_guards WHERE id IN (${ids.map(() => "?").join(",")})`,
          params: ids,
        },
        ids.length,
      );
    return { writes, expected };
  }
  function ack(raw: unknown, expected: readonly number[]) {
    try {
      const rows = capture(raw);
      return (
        Array.isArray(rows) &&
        rows.length === expected.length &&
        rows.every(
          (row, i) =>
            row &&
            typeof row === "object" &&
            Object.keys(row).sort().join() === "changes,rows" &&
            row.changes === expected[i] &&
            Array.isArray(row.rows) &&
            row.rows.length === 0,
        )
      );
    } catch {
      return false;
    }
  }
  async function execute(
    phase: NonNullable<CancelExecutionData["phase"]>,
    at: string | null,
  ): Promise<CancelExecutionData> {
    const native = q.kind === "native",
      accepted = phase.endsWith("-accepted"),
      prepare = phase === "cancel-release-step-prepared";
    const needed = accepted ? null : prepare || native ? "accept" : "prepare";
    if (held || started.has(phase) || (needed && !acknowledged.has(needed))) return hold();
    started.add(phase);
    try {
      if (accepted && (await readRows()).length !== 0) return hold();
      if (!accepted && !prepare && at === null) invalid();
      const p = await payload(at),
        compiled = statements(p, phase);
      stable();
      const physical: readonly SqlStatement[] = [
        {
          sql: `INSERT INTO ${MONEY_CUTOVER_PERMIT_TABLE} (singleton, epoch, writer_epoch) VALUES (1, '${MONEY_CUTOVER_EPOCH}', ?)`,
          params: [epoch],
        },
        ...compiled.writes,
        {
          sql: `DELETE FROM ${MONEY_CUTOVER_PERMIT_TABLE} WHERE singleton = 1 AND epoch = '${MONEY_CUTOVER_EPOCH}' AND writer_epoch = ?`,
          params: [epoch],
        },
      ];
      const sealed = Object.freeze(
        physical.map((x) =>
          Object.freeze({ sql: x.sql, params: Object.freeze([...(x.params ?? [])]) }),
        ),
      );
      const result: unknown = await observed(
        () => Reflect.apply(rBatch.value, R, [sealed]) as ReturnType<Sql["batch"]>,
      );
      if (held || !ack(result, [1, ...compiled.expected, 1])) return hold();
      const rows = await readRows(),
        receipt = accepted
          ? q.acceptanceReceiptRef
          : prepare
            ? q.preparationReceiptRef
            : q.dispatchReceiptRef;
      const own = rows.filter(
        (row) =>
          row.receipt_ref === receipt &&
          row.phase === phase &&
          row.context_json === contextJson &&
          row.history_context_json === contextJson &&
          row.all_rows_match === 1 &&
          row.original_json === p.originalJson &&
          row.fingerprint === p.fingerprint &&
          row.stripe_key === p.stripeKey,
      );
      const coherent = rows.every((row) => {
        if (typeof row.phase !== "string") return false;
        if (
          row.context_json !== contextJson ||
          row.history_context_json !== contextJson ||
          row.all_rows_match !== 1 ||
          row.history_original_json !== p.originalJson ||
          row.history_fingerprint !== p.fingerprint ||
          row.history_stripe_key !== p.stripeKey
        )
          return false;
        if (row.phase.endsWith("-accepted"))
          return (
            row.receipt_ref === q.acceptanceReceiptRef &&
            row.attempt_ref === q.acceptanceAttemptRef &&
            row.previous_receipt_ref === null &&
            row.recorded_at === p.createdAt &&
            row.command_updated_at === (q.kind === "native" ? q.original.updatedAt : p.createdAt)
          );
        if (row.phase === "cancel-release-step-prepared")
          return (
            q.kind === "pending-release" &&
            row.receipt_ref === q.preparationReceiptRef &&
            row.attempt_ref === q.preparationAttemptRef &&
            row.previous_receipt_ref === q.acceptanceReceiptRef &&
            row.recorded_at === q.original.stepCreatedAt &&
            row.command_updated_at === q.original.stepCreatedAt
          );
        return (
          !accepted &&
          !prepare &&
          row.phase === phase &&
          row.receipt_ref === q.dispatchReceiptRef &&
          row.attempt_ref === q.dispatchAttemptRef &&
          row.previous_receipt_ref ===
            (q.kind === "native" ? q.acceptanceReceiptRef : q.preparationReceiptRef) &&
          row.recorded_at === p.at &&
          row.command_updated_at === p.updatedAt
        );
      });
      const expectedRows = accepted ? 1 : prepare || q.kind === "native" ? 2 : 3;
      if (own.length !== 1 || !coherent || rows.length !== expectedRows) return hold();
      acknowledged.add(accepted ? "accept" : prepare ? "prepare" : "dispatch");
      return data("own-phase-ack-data", phase, rows);
    } catch {
      return hold();
    }
  }
  return Object.freeze({
    accept: () =>
      execute(q.kind === "native" ? "cancel-native-accepted" : "cancel-release-accepted", null),
    prepareRelease: () =>
      q.kind === "pending-release" ? execute("cancel-release-step-prepared", null) : hold(),
    firstDispatch: (at: string) =>
      execute(
        q.kind === "native" ? "cancel-native-first-dispatch" : "cancel-release-first-dispatch",
        at,
      ),
    readOriginal: () => hold(),
  });
}
