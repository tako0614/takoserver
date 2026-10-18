/** PRIVATE, UNMOUNTED fixed plan-change SQL mechanics. Every result is DATA, never NEW/provider permission.
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
import type { StripeBillingObject } from "./stripe-billing-client.ts";
import type {
  QualifiedSubscriptionPlan,
  SubscriptionPeriodTerms,
  SubscriptionPlanTarget,
} from "./stripe-subscription-plan-change.ts";

export interface PlanChangeExistingCustomerOriginal {
  readonly customer: CustomerCustodyInput;
  readonly r1: FinancialR1WriteCommand;
  readonly consent: ConsentCandidate;
  readonly desired: {
    readonly organizationId: string;
    readonly reference: string;
    readonly expectedSubscriptionRef: string;
    readonly kind: "plan-change";
    readonly planKey: string;
  };
  readonly frozen: {
    readonly target: SubscriptionPlanTarget;
    readonly plan: QualifiedSubscriptionPlan;
    readonly effectiveAt: string;
  };
  readonly selectionObservedAt: string;
  readonly createdAt: string;
  readonly admissionRef: string;
  readonly acceptanceAttemptRef: string;
  readonly acceptanceReceiptRef: string;
  readonly createAttemptRef: string;
  readonly createReceiptRef: string;
  readonly scheduleAttemptRef: string;
  readonly scheduleReceiptRef: string;
}
export interface PlanStepClockData {
  readonly createdAt: string;
  readonly observedAt: string;
  readonly dispatchedAt: string;
}
type Options = Parameters<typeof createFinancialRetainedR1Store>[0] & { readonly rawSql: Sql };
type Phase = "plan-accepted" | "plan-create-dispatched" | "plan-schedule-dispatched";
export type PlanChangeExecutionData = {
  readonly qualification: "unqualified-private-plan-change-sql-data-only";
  readonly original: PlanChangeExistingCustomerOriginal;
  readonly status:
    | "own-acceptance-ack-data"
    | "own-create-first-dispatch-ack-data"
    | "own-schedule-first-dispatch-ack-data"
    | "held-original-get-only";
  readonly observation: unknown;
};
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
const PURPOSE = "hosted_subscription";
function fail(code: string, _status = 409): never {
  throw new SqlError("invalid", code);
}
function invalid(): never {
  throw new SqlError("invalid", "closed original plan-change DATA mismatch");
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
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_processor_object", 503);
  return value as Record<string, unknown>;
}
function time(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    fail("invalid_period", 503);
}
function seconds(value: string): string {
  time(value);
  if (Date.parse(value) % 1000 !== 0) fail("invalid_period", 503);
  return String(Date.parse(value) / 1000);
}
function nextMonthlyBoundary(periodEnd: string, anchor: number): number {
  const boundary = new Date(periodEnd);
  const origin = new Date(anchor * 1000);
  const year = boundary.getUTCFullYear();
  const month = boundary.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return (
    Date.UTC(
      year,
      month,
      Math.min(origin.getUTCDate(), lastDay),
      origin.getUTCHours(),
      origin.getUTCMinutes(),
      origin.getUTCSeconds(),
    ) / 1000
  );
}
function id(value: unknown): string | null {
  return typeof value === "string"
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? String((value as Record<string, unknown>).id ?? "") || null
      : null;
}
function flatten(value: Json, prefix: string, form: Record<string, string>): void {
  if (value == null) form[prefix] = "";
  else if (Array.isArray(value)) {
    if (value.length === 0) form[prefix] = "";
    else
      value.forEach((item, index) => {
        flatten(item, `${prefix}[${index}]`, form);
      });
  } else if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) flatten(item, `${prefix}[${key}]`, form);
  } else form[prefix] = String(value);
}
function metadataFor(terms: SubscriptionPeriodTerms): Record<string, string> {
  return {
    takoserverPurpose: PURPOSE,
    organizationId: terms.organizationId,
    planKey: terms.planKey,
    pricingRevision: terms.pricingRevision,
  };
}
function assertPlan(plan: QualifiedSubscriptionPlan): void {
  if (
    !plan.planKey ||
    !plan.pricingRevision ||
    !/^price_[A-Za-z0-9_]+$/u.test(plan.priceId) ||
    !Number.isSafeInteger(plan.priceAmountMinor) ||
    plan.priceAmountMinor <= 0 ||
    !Number.isSafeInteger(plan.includedMinor) ||
    plan.includedMinor < 0
  )
    fail("unqualified_pricing_revision", 503);
}
function assertSchedule(
  schedule: StripeBillingObject,
  target: SubscriptionPlanTarget,
  allowCompleted = false,
): void {
  const defaults = object(schedule.default_settings);
  if (
    !/^sub_sched_[A-Za-z0-9_]+$/u.test(schedule.id) ||
    schedule.livemode !== false ||
    id(schedule.customer) !== target.terms.customerId ||
    (schedule.status === "active"
      ? id(schedule.subscription) !== target.terms.subscriptionId
      : !allowCompleted ||
        !["completed", "released"].includes(String(schedule.status)) ||
        (schedule.subscription != null &&
          id(schedule.subscription) !== target.terms.subscriptionId) ||
        (schedule.status === "released" &&
          (id(schedule.released_subscription) !== target.terms.subscriptionId ||
            !Number.isSafeInteger(schedule.released_at) ||
            Number(schedule.released_at) < Number(seconds(target.periodEnd))))) ||
    schedule.application != null ||
    schedule.on_behalf_of != null ||
    schedule.transfer_data != null ||
    !Array.isArray(schedule.phases) ||
    defaults.on_behalf_of != null ||
    defaults.transfer_data != null ||
    defaults.application_fee_percent != null ||
    defaults.billing_thresholds != null ||
    (defaults.billing_cycle_anchor != null && defaults.billing_cycle_anchor !== "automatic") ||
    (defaults.automatic_tax != null && object(defaults.automatic_tax).enabled !== false) ||
    (defaults.invoice_settings != null &&
      object(defaults.invoice_settings).issuer != null &&
      object(object(defaults.invoice_settings).issuer).type !== "self")
  )
    fail("schedule_readback_mismatch", 503);
}

/**
 * Reproduce every accepted current-phase setting. Reject unsupported settings
 * instead of dropping them. The narrow hosted lane has one fixed-price item,
 * no taxes, discounts, trials, invoice additions, Connect, or anchor changes.
 * Schedule default_settings are left untouched by the update.
 */
function phaseSettings(
  phase: Record<string, unknown>,
  target: SubscriptionPlanTarget,
): Record<string, Json> {
  const preserved = new Set([
    "collection_method",
    "default_payment_method",
    "description",
    "invoice_settings",
    "metadata",
  ]);
  const empty = new Set([
    "add_invoice_items",
    "application_fee_percent",
    "automatic_tax",
    "billing_thresholds",
    "default_tax_rates",
    "discounts",
    "on_behalf_of",
    "transfer_data",
    "trial_end",
    "trial_settings",
    "coupon",
  ]);
  const ignored = new Set([
    "start_date",
    "end_date",
    "items",
    "proration_behavior",
    "currency",
    "billing_cycle_anchor",
  ]);
  const settings: Record<string, Json> = {};
  for (const [key, value] of Object.entries(phase)) {
    if (preserved.has(key)) {
      if (key === "metadata") continue;
      if (value == null) continue;
      if (key === "default_payment_method") settings[key] = id(value);
      else if (key === "invoice_settings") {
        const invoice = object(value);
        if (
          Object.keys(invoice).some(
            (name) => !["account_tax_ids", "days_until_due", "issuer"].includes(name),
          ) ||
          (invoice.issuer != null && object(invoice.issuer).type !== "self")
        )
          fail("unsupported_schedule_settings");
        settings[key] = Object.fromEntries(
          Object.entries(invoice).filter(([, field]) => field != null),
        ) as Record<string, Json>;
      } else settings[key] = value as Json;
    } else if (empty.has(key)) {
      if (
        value != null &&
        !(Array.isArray(value) && value.length === 0) &&
        !(
          key === "automatic_tax" &&
          object(value).enabled === false &&
          object(value).liability == null
        )
      )
        fail("unsupported_schedule_settings", 409);
      if (key === "automatic_tax" && value != null) settings[key] = { enabled: false };
      else if ((key === "discounts" || key === "default_tax_rates") && Array.isArray(value))
        settings[key] = [];
    } else if (!ignored.has(key)) fail("unsupported_schedule_settings", 409);
  }
  if (
    (phase.currency != null && phase.currency !== "usd") ||
    (phase.billing_cycle_anchor != null && phase.billing_cycle_anchor !== "automatic") ||
    phase.start_date !== Number(seconds(target.periodStart)) ||
    !Array.isArray(phase.items) ||
    phase.items.length !== 1
  )
    fail("unsupported_schedule_settings", 409);
  const item = object(phase.items[0]);
  if (
    id(item.price) !== target.terms.priceId ||
    item.quantity !== 1 ||
    Object.keys(item).some(
      (key) =>
        ![
          "price",
          "plan",
          "quantity",
          "metadata",
          "tax_rates",
          "discounts",
          "billing_thresholds",
        ].includes(key),
    ) ||
    (item.tax_rates != null && (!Array.isArray(item.tax_rates) || item.tax_rates.length !== 0)) ||
    (item.discounts != null && (!Array.isArray(item.discounts) || item.discounts.length !== 0)) ||
    item.billing_thresholds != null
  )
    fail("unsupported_schedule_settings", 409);
  const meta = phase.metadata == null ? {} : object(phase.metadata);
  for (const [key, value] of Object.entries(metadataFor(target.terms)))
    if (meta[key] !== undefined && meta[key] !== value) fail("schedule_readback_mismatch", 503);
  settings.items = [
    {
      price: target.terms.priceId,
      quantity: 1,
      ...(item.metadata == null ? {} : { metadata: item.metadata as Json }),
      ...(item.tax_rates == null ? {} : { tax_rates: item.tax_rates as Json }),
      ...(item.discounts == null ? {} : { discounts: item.discounts as Json }),
    },
  ];
  settings.metadata = { ...meta, ...metadataFor(target.terms) } as Record<string, Json>;
  return settings;
}

const V = (path: string) => `json_extract(v.data,'$.${path}')`;
// Financial-owned literal: exact ordered Customer chain predicates, balanced OR/AND only.
// No Root/helper rewrite; NULL/unknown chain proof remains absent.
const PLAN_CUSTOMER_CHAIN_MATCH = `(NOT EXISTS(SELECT 1 FROM financial_customer_history_entries e
 LEFT JOIN financial_customer_history_receipts receipt ON receipt.receipt_ref=e.expected_history_receipt_ref
 LEFT JOIN financial_customer_history_receipts previous ON previous.receipt_ref=e.previous_history_receipt_ref
 LEFT JOIN customer_entry_matches valid ON valid.history_ref=e.history_ref AND valid.entry_ref=e.entry_ref
 WHERE e.history_ref=cv.history_ref AND ((((e.journal_sequence>hh.journal_sequence OR (receipt.receipt_ref IS NULL OR receipt.all_rows_match IS NOT 1)) OR ((receipt.entry_ref IS NOT e.entry_ref OR receipt.attempt_ref IS NOT e.coupling_attempt_ref) OR (receipt.history_ref IS NOT e.history_ref OR receipt.journal_sequence IS NOT e.journal_sequence))) OR (((receipt.evidence_kind IS NOT e.evidence_kind OR receipt.command_org_id IS NOT e.command_org_id) OR (receipt.l1_receipt_ref IS NOT e.l1_receipt_ref OR receipt.dispatch_receipt_ref IS NOT e.dispatch_receipt_ref)) OR ((receipt.custody_receipt_ref IS NOT e.custody_receipt_ref OR receipt.original_org_origin IS NOT cv.original_org_origin) OR (receipt.realm_registration IS NOT cv.realm_registration OR receipt.realm_incarnation IS NOT cv.realm_incarnation)))) OR ((e.journal_sequence>0 AND ((previous.receipt_ref IS NULL OR previous.history_ref IS NOT e.history_ref) OR ((previous.journal_sequence IS NOT e.journal_sequence-1 OR receipt.previous_history_receipt_ref IS NOT previous.receipt_ref) OR (receipt.previous_entry_ref IS NOT previous.entry_ref OR receipt.previous_journal_sequence IS NOT previous.journal_sequence)))) OR valid.entry_ref IS NULL))) AND ((EXISTS(SELECT 1 FROM financial_customer_history_entries e JOIN financial_customer_history_receipts receipt ON receipt.entry_ref=e.entry_ref
 WHERE e.history_ref=cv.history_ref AND e.journal_sequence=0 AND e.evidence_kind='genesis' AND receipt.receipt_ref=cv.expected_receipt_ref) AND (SELECT count(*) FROM financial_customer_history_entries e WHERE e.history_ref=cv.history_ref)=hh.journal_sequence+1) AND EXISTS(SELECT 1 FROM financial_customer_history_entries e JOIN financial_customer_history_receipts receipt ON receipt.entry_ref=e.entry_ref
 WHERE e.entry_ref=hh.last_entry_ref AND e.history_ref=cv.history_ref AND e.journal_sequence=hh.journal_sequence
 AND receipt.receipt_ref=hh.last_expected_receipt_ref AND receipt.all_rows_match=1)))`;

const COMMAND_INSERT = `INSERT INTO stripe_billing_plan_changes(org_id,reference,fingerprint,kind,expected_subscription_ref,subscription_id,expected_generation,desired_json,frozen_json,state,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL,?)`;
const SLOT_INSERT = `INSERT INTO stripe_billing_plan_change_slots(org_id,reference,generation) VALUES(?,?,?) ON CONFLICT(org_id) DO UPDATE SET reference=excluded.reference,generation=excluded.generation`;
const STEP_INSERT = `INSERT OR IGNORE INTO stripe_billing_plan_change_steps(org_id,reference,step,request_json,idempotency_key,state,remote_id,response_json,created_at,dispatched_at,verified_at) VALUES(?,?,?,?,?,'prepared',NULL,NULL,?,NULL,NULL)`;
const STEP_CAS =
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

/** No supplied SQL/callback/native operation. Every return is DATA, not NEW permission. */
export function createPlanChangeExistingCustomerData(
  options: Options,
  original: PlanChangeExistingCustomerOriginal,
) {
  const q = capture(original),
    realm = capture(options.realm);
  if (
    Object.keys(q).sort().join() !==
    "acceptanceAttemptRef,acceptanceReceiptRef,admissionRef,consent,createAttemptRef,createReceiptRef,createdAt,customer,desired,frozen,r1,scheduleAttemptRef,scheduleReceiptRef,selectionObservedAt"
  )
    invalid();
  const S = options.sql,
    R = options.rawSql,
    epoch = options.writerEpoch;
  const methods = [S, R].flatMap((port) =>
    (["query", "run", "batch"] as const).map((name) => ({
      port,
      name,
      descriptor: Object.getOwnPropertyDescriptor(port, name),
    })),
  );
  for (const m of methods)
    if (!m.descriptor || !("value" in m.descriptor) || typeof m.descriptor.value !== "function")
      invalid();
  const rawQuery = methods[3]!.descriptor!.value,
    rawBatch = methods[5]!.descriptor!.value;
  function stable() {
    assertMoneyCutoverSqlBackingOrigin(S, { rawSql: R, writerEpoch: epoch });
    for (const m of methods) {
      const current = Object.getOwnPropertyDescriptor(m.port, m.name);
      if (!current || !("value" in current) || current.value !== m.descriptor!.value) invalid();
    }
  }
  stable();
  const contextJson = JSON.stringify({ original: q, realm });
  if (
    new TextEncoder().encode(JSON.stringify(q.customer)).length > 1048576 ||
    new TextEncoder().encode(JSON.stringify(q.r1)).length > 98304 ||
    new TextEncoder().encode(contextJson).length > 2097152
  )
    invalid();
  const retained = createFinancialRetainedR1Store(options),
    customer = createCustomerTrackedExecutionData(R);
  let held = false,
    accepted = false,
    createDispatched = false;
  const started = new Set<Phase>();
  const observedReceipts: { readonly stepJson: string; readonly recordedAt: string }[] = [];
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
      await observed(() => Reflect.apply(rawQuery, R, [sql, params]) as ReturnType<Sql["query"]>),
    );
    if (
      !Array.isArray(rows) ||
      rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))
    )
      invalid();
    return rows as readonly Row[];
  }
  async function readRows() {
    return query(
      `SELECT c.*,a.admission_ref,a.context_json AS admission_context,h.* FROM stripe_billing_plan_changes c LEFT JOIN financial_plan_change_admissions a ON a.org_id=c.org_id AND a.reference=c.reference LEFT JOIN financial_plan_change_history_receipts h ON h.admission_ref=a.admission_ref WHERE c.org_id=? AND c.reference=? ORDER BY h.sequence`,
      [q.desired.organizationId, q.desired.reference],
    );
  }
  function data(
    status: PlanChangeExecutionData["status"],
    observation: unknown,
  ): PlanChangeExecutionData {
    return Object.freeze({
      qualification: "unqualified-private-plan-change-sql-data-only",
      original: q,
      status,
      observation: capture(observation),
    });
  }
  async function hold(): Promise<PlanChangeExecutionData> {
    held = true;
    try {
      return data("held-original-get-only", await readRows());
    } catch {
      return data("held-original-get-only", { status: "unknown-read-or-method-drift" });
    }
  }
  function ack(value: unknown, expected: readonly number[]) {
    try {
      const rows = capture(value);
      return (
        Array.isArray(rows) &&
        rows.length === expected.length &&
        rows.every(
          (r, i) =>
            r &&
            typeof r === "object" &&
            Object.keys(r).sort().join() === "changes,rows" &&
            r.changes === expected[i] &&
            Array.isArray(r.rows) &&
            r.rows.length === 0,
        )
      );
    } catch {
      return false;
    }
  }
  async function payload(phase: Phase, clock: PlanStepClockData | null) {
    iso(q.createdAt);
    iso(q.selectionObservedAt);
    for (const value of Object.values(clock ?? {})) iso(value);
    if (clock && Object.keys(clock).sort().join() !== "createdAt,dispatchedAt,observedAt")
      invalid();
    const refs = [
      q.admissionRef,
      q.acceptanceAttemptRef,
      q.acceptanceReceiptRef,
      q.createAttemptRef,
      q.createReceiptRef,
      q.scheduleAttemptRef,
      q.scheduleReceiptRef,
    ];
    if (
      new Set(refs).size !== 7 ||
      refs.some((x) => typeof x !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/u.test(x))
    )
      invalid();
    compileCustomerPhase(q.customer);
    const desired = q.desired,
      target = q.frozen.target,
      plan = q.frozen.plan,
      r = q.r1.original,
      action = parseSharedFinancialAction(r.c0.selection.action.body);
    if (
      q.customer.phase !== "N" ||
      q.customer.writerEpoch !== epoch ||
      desired.kind !== "plan-change" ||
      action.kind !== "plan-change" ||
      r.economic.kind !== "plan-change" ||
      canonicalJson(action) !== canonicalJson(desired)
    )
      invalid();
    if (
      Object.keys(desired).sort().join() !==
        "expectedSubscriptionRef,kind,organizationId,planKey,reference" ||
      Object.keys(q.frozen).sort().join() !== "effectiveAt,plan,target"
    )
      invalid();
    if (
      Object.keys(target).sort().join() !==
        "billingCycleAnchor,cancelAtPeriodEnd,generation,originalEffectiveAt,periodEnd,periodStart,scheduleId,subscriptionRef,terms,unresolvedSettlement" ||
      Object.keys(plan).sort().join() !==
        "includedMinor,planKey,priceAmountMinor,priceId,pricingRevision" ||
      Object.keys(target.terms).sort().join() !==
        "customerId,includedMinor,organizationId,planKey,priceAmountMinor,priceId,pricingRevision,subscriptionId"
    )
      invalid();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(desired.reference) ||
      !/^sra_[0-9a-f]{64}$/u.test(desired.expectedSubscriptionRef) ||
      !/^sub_[A-Za-z0-9_]+$/u.test(target.terms.subscriptionId) ||
      !/^cus_[A-Za-z0-9_]+$/u.test(target.terms.customerId)
    )
      invalid();
    if (
      target.subscriptionRef !== desired.expectedSubscriptionRef ||
      target.terms.organizationId !== desired.organizationId ||
      target.terms.customerId !== q.customer.nativeOriginal.customerId ||
      target.terms.organizationId !== q.customer.nativeOriginal.organizationId ||
      target.cancelAtPeriodEnd !== false ||
      target.unresolvedSettlement !== false ||
      target.scheduleId !== null ||
      q.frozen.effectiveAt !== target.periodEnd ||
      plan.planKey !== desired.planKey
    )
      invalid();
    time(target.periodStart);
    time(target.periodEnd);
    time(target.originalEffectiveAt);
    if (
      target.periodStart >= target.periodEnd ||
      target.originalEffectiveAt > target.periodStart ||
      target.periodEnd <= (clock?.observedAt ?? q.selectionObservedAt) ||
      !Number.isSafeInteger(target.generation) ||
      target.generation < 0 ||
      !Number.isSafeInteger(target.billingCycleAnchor)
    )
      invalid();
    assertPlan(target.terms);
    assertPlan(plan);
    if (
      plan.planKey === target.terms.planKey &&
      plan.pricingRevision === target.terms.pricingRevision
    )
      invalid();
    const econ = {
      kind: "plan-change",
      expectedSubscriptionRef: target.subscriptionRef,
      targetSubscriptionId: target.terms.subscriptionId,
      targetGeneration: target.generation,
      targetPeriodStart: target.periodStart,
      targetPeriodEnd: target.periodEnd,
      ...plan,
      currency: "USD",
    };
    if (
      canonicalJson(econ) !== canonicalJson(r.economic) ||
      r.scopeRealm.writerEpoch !== epoch ||
      realm.accountId !== r.scopeRealm.accountId ||
      realm.financialRealm !== r.scopeRealm.financialRealm ||
      realm.livemode !== false ||
      realm.billingAuthority !== r.scopeRealm.billingAuthority ||
      r.c0.selection.customer.idempotencyKey !== q.customer.nativeOriginal.commandKey ||
      r.c0.selection.customer.requestFingerprint !== q.customer.nativeOriginal.fingerprint ||
      q.consent.challengeRef !== q.r1.key.challengeRef ||
      q.consent.actionKind !== "plan-change" ||
      q.consent.actionRef !== desired.reference ||
      q.consent.requestFingerprint !== r.c0.challenge.requestFingerprint
    )
      invalid();
    const expectedRef = `sra_${(await observed(() => canonicalDigest(["takoserver-subscription-association-ref:v1", desired.organizationId, target.terms.subscriptionId, target.terms.customerId, false]))).slice(7)}`;
    if (expectedRef !== target.subscriptionRef) invalid();
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
    const fingerprint = await observed(() => canonicalDigest([realm, desired]));
    let form: Record<string, string> | null = null,
      key: string | null = null,
      scheduleId: string | null = null,
      createResponseJson: string | null = null;
    const name =
      phase === "plan-create-dispatched"
        ? "create"
        : phase === "plan-schedule-dispatched"
          ? "schedule"
          : null;
    if (name !== null) {
      key = `takos-plan-${await observed(() => canonicalDigest([realm, { org: desired.organizationId, reference: desired.reference, step: name }]))}`;
      if (name === "create") form = { from_subscription: target.terms.subscriptionId };
      else {
        const rows = await query(
          "SELECT * FROM stripe_billing_plan_change_steps WHERE org_id=? AND reference=? AND step='create'",
          [desired.organizationId, desired.reference],
        );
        const row = rows[0];
        if (
          rows.length !== 1 ||
          !row ||
          row.state !== "verified" ||
          typeof row.remote_id !== "string" ||
          typeof row.response_json !== "string"
        )
          invalid();
        const createKey = `takos-plan-${await observed(() => canonicalDigest([realm, { org: desired.organizationId, reference: desired.reference, step: "create" }]))}`;
        if (
          row.idempotency_key !== createKey ||
          row.request_json !== canonicalJson({ from_subscription: target.terms.subscriptionId })
        )
          invalid();
        const before = capture(JSON.parse(row.response_json)) as StripeBillingObject;
        if (canonicalJson(before) !== row.response_json || before.id !== row.remote_id) invalid();
        assertSchedule(before, target);
        if (!Array.isArray(before.phases) || before.phases.length !== 1) invalid();
        scheduleId = row.remote_id;
        createResponseJson = row.response_json;
        const current = phaseSettings(object(before.phases[0]), target),
          desiredTerms = { ...target.terms, ...plan };
        form = {
          end_behavior: "release",
          proration_behavior: "none",
          "metadata[takoserverPlanCommand]": fingerprint,
        };
        flatten(
          {
            ...current,
            start_date: Number(seconds(target.periodStart)),
            end_date: Number(seconds(target.periodEnd)),
            proration_behavior: "none",
          },
          "phases[0]",
          form,
        );
        flatten(
          {
            ...current,
            items: [
              {
                ...object((current.items as readonly Json[])[0]),
                price: plan.priceId,
                quantity: 1,
              },
            ] as Json,
            metadata: { ...object(current.metadata), ...metadataFor(desiredTerms) } as Json,
            start_date: Number(seconds(target.periodEnd)),
            end_date: nextMonthlyBoundary(target.periodEnd, target.billingCycleAnchor),
            proration_behavior: "none",
          },
          "phases[1]",
          form,
        );
      }
    }
    // Local A selection contains only closed metadata; the full raw body remains in
    // the exact R1 original/receipt and is verified by readJoinedRetainedR1Data above.
    const terms = r.selectedTerms;
    const termsSelectionJson = canonicalJson({
      ref: terms.ref,
      digest: terms.digest,
      mediaType: terms.mediaType,
      locale: terms.locale,
      bodyByteLength: terms.bodyByteLength,
      digestRecipe: terms.digestRecipe,
    });
    const stepJson = canonicalJson({ name, key, form, scheduleId, createResponseJson, clock });
    if (new TextEncoder().encode(stepJson).length > 2097152) invalid();
    return {
      q,
      realm,
      contextJson,
      termsSelectionJson,
      fingerprint,
      desiredJson: canonicalJson(desired),
      frozenJson: canonicalJson(q.frozen),
      termsJson: canonicalJson(target.terms),
      r1Json: canonicalJson(q.r1),
      c0Json: canonicalJson({ ...r.c0, scope: r.scopeRealm }),
      epoch,
      phase,
      clock,
      form,
      key,
      name,
      scheduleId,
      createResponseJson,
      stepJson,
    };
  }
  type Payload = Awaited<ReturnType<typeof payload>>;
  function ctes(current: string) {
    return `WITH v(data) AS (VALUES (?)), customer_match_scope(history_ref) AS MATERIALIZED (SELECT ${V("q.customer.history.historyRef")} FROM v), ${CUSTOMER_MATCH_CTES}, current_plan_proof AS MATERIALIZED (${current})`;
  }
  function proof(p: Payload) {
    const g = guard(q.consent, q.desired.organizationId);
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
      AND ro.terms_ref IS ${V("q.r1.original.selectedTerms.ref")} AND ro.terms_digest IS ${V("q.r1.original.selectedTerms.digest")}
      JOIN financial_retained_r1_receipts rr ON rr.r1_ref=ro.r1_ref AND rr.receipt_ref=ro.receipt_ref AND rr.command_json=ro.command_json
      AND rr.original_digest=ro.original_digest AND rr.all_rows_match IS 1
      JOIN financial_action_source_registrations ars ON ars.registration_ref=ro.source_registration_ref AND ars.incarnation=ro.source_incarnation
      AND ars.registration_digest=ro.source_registration_digest
      JOIN financial_preproof_challenges c0 ON c0.challenge_ref=ro.challenge_ref AND c0.preparation_ref=ro.preparation_ref AND c0.record_json IS ${V("c0Json")}
      JOIN financial_preproof_challenge_receipts c0r ON c0r.challenge_ref=c0.challenge_ref AND c0r.preparation_ref=c0.preparation_ref
      AND c0r.receipt_ref IS ${V("q.r1.original.c0ReceiptRef")} AND c0r.record_json=c0.record_json AND c0r.all_rows_match IS 1
      WHERE (((c.action_json IS json_extract(${V("r1Json")},'$.original.c0.selection.action.body') AND json_type(c.selection_json,'$.selectedTerms') IS 'object') AND (json_extract(c.selection_json,'$.selectedTerms') IS ${V("termsSelectionJson")} AND NOT EXISTS(SELECT 1 FROM financial_payer_grant_revocations revoked WHERE revoked.grant_ref=g.grant_ref))) AND (EXISTS(SELECT 1 ${CUSTOMER_COVERAGE_JOINS}
      JOIN financial_customer_history_entries e ON e.history_ref=cv.history_ref AND e.transition_ref IS ${V("q.customer.custodyReceiptRef")}
      JOIN financial_customer_history_receipts h ON h.entry_ref=e.entry_ref AND h.receipt_ref IS ${V("q.customer.historyReceiptRef")}
      WHERE cv.history_ref IS ${V("q.customer.history.historyRef")} AND e.evidence_kind='customer-verified-binding'
      AND e.original_command_key IS ${V("q.customer.nativeOriginal.commandKey")} AND e.command_org_id=c.organization_id
      AND e.command_after_customer_id IS ${V("q.frozen.target.terms.customerId")} AND e.entry_ref IS ${V("q.customer.entryRef")}
      AND ${CUSTOMER_COVERAGE_MATCH} AND ${PLAN_CUSTOMER_CHAIN_MATCH} AND ${CUSTOMER_CURRENT_CUSTODY_MATCH}) AND ((EXISTS(SELECT 1 FROM stripe_billing_subscriptions sub JOIN stripe_billing_associations a
        ON a.org_id=sub.org_id AND a.subscription_id=sub.subscription_id
        WHERE sub.org_id IS ${V("q.desired.organizationId")} AND sub.subscription_id IS ${V("q.frozen.target.terms.subscriptionId")}
        AND sub.customer_id IS ${V("q.frozen.target.terms.customerId")} AND a.customer_id IS sub.customer_id AND a.livemode=0
        AND a.association_generation IS ${V("q.frozen.target.generation")}
        AND a.association_generation=(SELECT MAX(association_generation) FROM stripe_billing_associations WHERE org_id=sub.org_id)
        AND sub.status='active' AND sub.cancel_at_period_end=0
        AND sub.period_start IS ${V("q.frozen.target.periodStart")} AND sub.period_end IS ${V("q.frozen.target.periodEnd")} ) AND EXISTS(SELECT 1 FROM stripe_billing_subscription_terms t WHERE t.subscription_id IS ${V("q.frozen.target.terms.subscriptionId")}
        AND t.org_id IS ${V("q.desired.organizationId")} AND t.terms_json IS ${V("termsJson")}
        AND t.effective_at<=${V("q.frozen.target.periodStart")}
        AND NOT EXISTS(SELECT 1 FROM stripe_billing_subscription_term_revocations revoked WHERE revoked.subscription_id=t.subscription_id AND revoked.effective_at=t.effective_at AND revoked.released_at<t.effective_at)
        AND NOT EXISTS(SELECT 1 FROM stripe_billing_subscription_terms newer WHERE newer.subscription_id=t.subscription_id AND newer.effective_at>t.effective_at AND newer.effective_at<=${V("q.frozen.target.periodStart")} AND NOT EXISTS(SELECT 1 FROM stripe_billing_subscription_term_revocations revoked_newer WHERE revoked_newer.subscription_id=newer.subscription_id AND revoked_newer.effective_at=newer.effective_at AND revoked_newer.released_at<newer.effective_at)))) AND NOT EXISTS(SELECT 1 FROM stripe_billing_subscription_terms crossing WHERE crossing.subscription_id IS ${V("q.frozen.target.terms.subscriptionId")} AND crossing.effective_at>${V("q.frozen.target.periodStart")} AND crossing.effective_at<${V("q.frozen.target.periodEnd")} AND NOT EXISTS(SELECT 1 FROM stripe_billing_subscription_term_revocations revoked_crossing WHERE revoked_crossing.subscription_id=crossing.subscription_id AND revoked_crossing.effective_at=crossing.effective_at AND revoked_crossing.released_at<crossing.effective_at)))))`;
    const envelope = JSON.stringify(p);
    if (new TextEncoder().encode(envelope).length > 2097152) invalid();
    return { sql, params: [envelope, ...g.params] };
  }
  function mechanicalGuard(
    condition: string,
    params: readonly (string | number | null)[],
    id: string,
  ): SqlStatement {
    return {
      sql: `INSERT INTO wallet_allocation_guards (id,valid) VALUES (?,CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
      params: [id, ...params],
    };
  }
  function targetGuard(id: string): SqlStatement {
    const t = q.frozen.target;
    return mechanicalGuard(
      TARGET_FENCE,
      [
        t.terms.organizationId,
        t.terms.subscriptionId,
        t.terms.customerId,
        t.generation,
        t.terms.organizationId,
        t.terms.organizationId,
        t.terms.organizationId,
        t.terms.organizationId,
        t.terms.subscriptionId,
      ],
      id,
    );
  }
  function statements(p: Payload): {
    physical: readonly SqlStatement[];
    changes: readonly number[];
  } {
    const full = proof(p),
      prefix = ctes(full.sql),
      d = q.desired,
      t = q.frozen.target;
    const phase = p.phase,
      acceptance = phase === "plan-accepted",
      create = phase === "plan-create-dispatched",
      sequence = acceptance ? 0 : create ? 1 : 2;
    const attempt = acceptance
      ? q.acceptanceAttemptRef
      : create
        ? q.createAttemptRef
        : q.scheduleAttemptRef;
    const receipt = acceptance
      ? q.acceptanceReceiptRef
      : create
        ? q.createReceiptRef
        : q.scheduleReceiptRef;
    const previous = acceptance ? null : create ? q.acceptanceReceiptRef : q.createReceiptRef;
    const ids = [`plan_guard_${attempt}:target`, `plan_guard_${attempt}:slot`];
    const writes: SqlStatement[] = [
      targetGuard(ids[0]!),
      mechanicalGuard(
        acceptance
          ? "NOT EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=?)"
          : "EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=? AND reference=?)",
        acceptance ? [d.organizationId] : [d.organizationId, d.reference],
        ids[1]!,
      ),
    ];
    const changes = [1, 1];
    if (acceptance) {
      writes.push(
        {
          sql: COMMAND_INSERT,
          params: [
            d.organizationId,
            d.reference,
            p.fingerprint,
            d.kind,
            d.expectedSubscriptionRef,
            t.terms.subscriptionId,
            t.generation,
            p.desiredJson,
            p.frozenJson,
            q.createdAt,
          ],
        },
        { sql: SLOT_INSERT, params: [d.organizationId, d.reference, 1] },
      );
      changes.push(1, 1);
      writes.push({
        sql: `${prefix} INSERT INTO financial_plan_change_admissions(admission_ref,org_id,reference,fingerprint,desired_json,frozen_json,context_json,customer_custody_ref,customer_history_receipt_ref,r1_ref,r1_receipt_ref,grant_ref,consent_receipt_ref,acceptance_receipt_ref,create_receipt_ref,schedule_receipt_ref,writer_epoch,created_at) SELECT ${["q.admissionRef", "q.desired.organizationId", "q.desired.reference", "fingerprint", "desiredJson", "frozenJson", "contextJson", "q.customer.custodyReceiptRef", "q.customer.historyReceiptRef", "q.r1.key.r1Ref", "q.r1.r1ReceiptRef", "q.consent.grantRef", "q.consent.receiptRef", "q.acceptanceReceiptRef", "q.createReceiptRef", "q.scheduleReceiptRef", "epoch", "q.createdAt"].map(V).join(",")} FROM v WHERE changes()=1 AND EXISTS(SELECT 1 FROM current_plan_proof)`,
        params: full.params,
      });
      changes.push(1);
    } else {
      writes.push({
        sql: STEP_INSERT,
        params: [
          d.organizationId,
          d.reference,
          p.name,
          canonicalJson(p.form),
          p.key,
          p.clock!.createdAt,
        ],
      });
      changes.push(1);
      ids.push(`plan_guard_${attempt}:newstep`);
      writes.push(mechanicalGuard("changes()=1", [], ids[2]!));
      changes.push(1);
      writes.push({
        sql: STEP_CAS,
        params: [p.clock!.dispatchedAt, d.organizationId, d.reference, p.name],
      });
      changes.push(1);
      ids.push(`plan_guard_${attempt}:cas`);
      writes.push(mechanicalGuard("changes()=1", [], ids[3]!));
      changes.push(1);
    }
    writes.push({
      sql: `${prefix} INSERT INTO financial_plan_change_history_receipts(receipt_ref,attempt_ref,admission_ref,sequence,phase,previous_receipt_ref,org_id,reference,fingerprint,context_json,step_json,recorded_at,all_rows_match)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN changes()=1 AND current_match.matched IS 1
      AND EXISTS(SELECT 1 FROM financial_plan_change_admissions a CROSS JOIN v WHERE a.admission_ref IS ${V("q.admissionRef")} AND a.context_json IS ${V("contextJson")} AND a.fingerprint IS ${V("fingerprint")})
      ${phase === "plan-schedule-dispatched" ? `AND EXISTS(SELECT 1 FROM stripe_billing_plan_change_steps created CROSS JOIN v WHERE created.org_id IS ${V("q.desired.organizationId")} AND created.reference IS ${V("q.desired.reference")} AND created.step='create' AND created.state='verified' AND created.remote_id IS ${V("scheduleId")} AND created.response_json IS ${V("createResponseJson")})` : ""}
      THEN 1 ELSE 0 END
      FROM v LEFT JOIN (SELECT 1 AS matched FROM current_plan_proof LIMIT 1) current_match ON 1`,
      params: [
        ...full.params,
        receipt,
        attempt,
        q.admissionRef,
        sequence,
        phase,
        previous,
        d.organizationId,
        d.reference,
        p.fingerprint,
        contextJson,
        p.stepJson,
        p.clock?.dispatchedAt ?? q.createdAt,
      ],
    });
    changes.push(1);
    writes.push({
      sql: `DELETE FROM wallet_allocation_guards WHERE id IN (${ids.map(() => "?").join(",")})`,
      params: ids,
    });
    changes.push(ids.length);
    const physical = [
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
    return {
      physical: Object.freeze(
        physical.map((s) =>
          Object.freeze({ sql: s.sql, params: Object.freeze([...(s.params ?? [])]) }),
        ),
      ),
      changes: [1, ...changes, 1],
    };
  }
  async function execute(
    phase: Phase,
    clock: PlanStepClockData | null,
  ): Promise<PlanChangeExecutionData> {
    const acceptance = phase === "plan-accepted";
    if (
      held ||
      started.has(phase) ||
      (!acceptance && !accepted) ||
      (phase === "plan-schedule-dispatched" && !createDispatched)
    )
      return hold();
    started.add(phase);
    try {
      stable();
      if (acceptance && (await readRows()).length !== 0) return hold();
      if (
        !acceptance &&
        (
          await query(
            "SELECT 1 FROM stripe_billing_plan_change_steps WHERE org_id=? AND reference=? AND step=?",
            [
              q.desired.organizationId,
              q.desired.reference,
              phase === "plan-create-dispatched" ? "create" : "schedule",
            ],
          )
        ).length !== 0
      )
        return hold();
      const p = await payload(phase, clock);
      if (held) return hold();
      const batch = statements(p);
      const result = await observed(
        () => Reflect.apply(rawBatch, R, [batch.physical]) as ReturnType<Sql["batch"]>,
      );
      if (held || !ack(result, batch.changes)) return hold();
      const rows = await readRows(),
        expectedCount = acceptance ? 1 : phase === "plan-create-dispatched" ? 2 : 3;
      const expectedRefs = [q.acceptanceReceiptRef, q.createReceiptRef, q.scheduleReceiptRef];
      const expectedAttempts = [q.acceptanceAttemptRef, q.createAttemptRef, q.scheduleAttemptRef];
      const expectedPhases: readonly Phase[] = [
        "plan-accepted",
        "plan-create-dispatched",
        "plan-schedule-dispatched",
      ];
      const currentReceipt = {
        stepJson: p.stepJson,
        recordedAt: clock?.dispatchedAt ?? q.createdAt,
      };
      const expectedOriginals = [...observedReceipts, currentReceipt];
      if (
        rows.length !== expectedCount ||
        expectedOriginals.length !== expectedCount ||
        rows.some(
          (row, i) =>
            row.receipt_ref !== expectedRefs[i] ||
            row.attempt_ref !== expectedAttempts[i] ||
            row.phase !== expectedPhases[i] ||
            row.sequence !== i ||
            row.previous_receipt_ref !== (i === 0 ? null : expectedRefs[i - 1]) ||
            row.admission_ref !== q.admissionRef ||
            row.org_id !== q.desired.organizationId ||
            row.reference !== q.desired.reference ||
            row.context_json !== contextJson ||
            row.admission_context !== contextJson ||
            row.all_rows_match !== 1 ||
            row.fingerprint !== p.fingerprint ||
            row.kind !== "plan-change" ||
            row.expected_subscription_ref !== q.desired.expectedSubscriptionRef ||
            row.subscription_id !== q.frozen.target.terms.subscriptionId ||
            row.expected_generation !== q.frozen.target.generation ||
            row.desired_json !== p.desiredJson ||
            row.frozen_json !== p.frozenJson ||
            row.state !== "pending" ||
            row.receipt_json !== null ||
            row.created_at !== q.createdAt ||
            row.step_json !== expectedOriginals[i]?.stepJson ||
            row.recorded_at !== expectedOriginals[i]?.recordedAt,
        )
      )
        return hold();
      observedReceipts.push(currentReceipt);
      if (acceptance) accepted = true;
      if (phase === "plan-create-dispatched") createDispatched = true;
      return data(
        acceptance
          ? "own-acceptance-ack-data"
          : phase === "plan-create-dispatched"
            ? "own-create-first-dispatch-ack-data"
            : "own-schedule-first-dispatch-ack-data",
        rows,
      );
    } catch {
      return hold();
    }
  }
  return Object.freeze({
    accept: () => execute("plan-accepted", null),
    firstCreateDispatch: (clock: PlanStepClockData) =>
      execute("plan-create-dispatched", capture(clock)),
    firstScheduleDispatch: (clock: PlanStepClockData) =>
      execute("plan-schedule-dispatched", capture(clock)),
    async readOriginal() {
      held = true;
      return hold();
    },
  });
}
