import { bytesDigest, canonicalJson } from "./json.ts";
import type { Clock, Row, Sql, SqlParam, SqlStatement } from "./ports.ts";
import type { StripeBillingClient, StripeBillingObject } from "./stripe-billing-client.ts";
import type {
  SubscriptionCancellationCommandDescriptor,
  SubscriptionPlanCommandDescriptor,
} from "./subscription-command-receipts.ts";

const PURPOSE = "hosted_subscription";
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TARGET_REF = /^sra_[0-9a-f]{64}$/u;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export interface SubscriptionPeriodTerms {
  readonly organizationId: string;
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly planKey: string;
  readonly pricingRevision: string;
  readonly priceId: string;
  readonly priceAmountMinor: number;
  readonly includedMinor: number;
}

export interface QualifiedSubscriptionPlan {
  readonly planKey: string;
  readonly pricingRevision: string;
  readonly priceId: string;
  readonly priceAmountMinor: number;
  readonly includedMinor: number;
}

export interface SubscriptionPlanTarget {
  readonly subscriptionRef: string;
  readonly generation: number;
  readonly terms: SubscriptionPeriodTerms;
  readonly originalEffectiveAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly billingCycleAnchor: number;
  readonly cancelAtPeriodEnd: boolean;
  readonly unresolvedSettlement: boolean;
  readonly scheduleId: string | null;
}

export type SubscriptionPlanChangeReceipt =
  | { readonly state: "pending"; readonly subscriptionRef: string }
  | {
      readonly state: "verified";
      readonly subscriptionRef: string;
      readonly pendingChange: {
        readonly planKey: string;
        readonly pricingRevision: string;
        readonly effectiveAt: string;
      };
    };

export type SubscriptionPlanCancellationReceipt =
  | { readonly state: "pending"; readonly subscriptionRef: string }
  | { readonly state: "verified"; readonly subscriptionRef: string; readonly effectiveAt: string };

export type SubscriptionExtensionCommandDescriptor =
  | SubscriptionCancellationCommandDescriptor
  | SubscriptionPlanCommandDescriptor;

/**
 * This seam must be composed by the owner of the existing subscription custody.
 * The fence must cover its original association, newest association generation,
 * and Checkout/cancellation exclusion. A second independently managed binding or
 * an in-memory lock does not implement this contract.
 */
export interface SubscriptionPlanCustody {
  /** Fresh ownership/processor-realm proof without requalifying frozen pricing. */
  verifyTarget?(target: SubscriptionPlanTarget): Promise<void>;
  readTarget(
    organizationId: string,
    expectedSubscriptionRef: string,
  ): Promise<SubscriptionPlanTarget>;
  originalTerms(subscriptionId: string): Promise<{
    readonly terms: SubscriptionPeriodTerms;
    readonly effectiveAt: string;
  }>;
  fence(target: SubscriptionPlanTarget): {
    readonly condition: string;
    readonly params: readonly SqlParam[];
  };
  cancel(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly expectedSubscriptionRef: string;
    readonly cancelAtPeriodEnd: true;
  }): Promise<SubscriptionPlanCancellationReceipt>;
  /**
   * A from_subscription create cannot include command metadata. A lost response
   * therefore cannot be attributed merely by observing subscription.schedule.
   * Return only a schedule proven to belong to this exact frozen create step.
   * Null keeps the original command pending, without another POST.
   */
  recoverCreatedSchedule(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly subscriptionId: string;
    readonly idempotencyKey: string;
  }): Promise<StripeBillingObject | null>;
}

interface Command {
  readonly organizationId: string;
  readonly reference: string;
  readonly fingerprint: string;
  readonly kind: "plan-change" | "cancel";
  readonly frozen: Frozen;
  readonly state: "pending" | "verified";
  readonly receipt: SubscriptionPlanChangeReceipt | SubscriptionPlanCancellationReceipt | null;
}
interface Frozen {
  readonly target: SubscriptionPlanTarget;
  readonly plan?: QualifiedSubscriptionPlan;
  readonly pendingReference?: string;
  readonly scheduleId?: string;
  readonly effectiveAt?: string;
  readonly custodyRequestKeyDigest?: string;
}
interface Step {
  readonly state: "prepared" | "dispatched" | "verified";
  readonly key: string;
  readonly request: Record<string, string>;
  readonly remoteId: string | null;
  readonly response: StripeBillingObject | null;
}

export class SubscriptionPlanChangeError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
    this.name = "SubscriptionPlanChangeError";
  }
}
function fail(code: string, status = 409): never {
  throw new SubscriptionPlanChangeError(code, status);
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
function json<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}
function commandFrom(row: Row): Command {
  if (
    (row.kind !== "plan-change" && row.kind !== "cancel") ||
    (row.state !== "pending" && row.state !== "verified")
  )
    fail("unsupported_subscription_command", 503);
  return {
    organizationId: String(row.org_id),
    reference: String(row.reference),
    fingerprint: String(row.fingerprint),
    kind: row.kind as Command["kind"],
    frozen: json<Frozen>(row.frozen_json),
    state: row.state as Command["state"],
    receipt: row.receipt_json == null ? null : json<Command["receipt"]>(row.receipt_json),
  };
}
function stepFrom(row: Row): Step {
  return {
    state: row.state as Step["state"],
    key: String(row.idempotency_key),
    request: json<Record<string, string>>(row.request_json),
    remoteId: row.remote_id == null ? null : String(row.remote_id),
    response: row.response_json == null ? null : json<StripeBillingObject>(row.response_json),
  };
}
function guard(condition: string, params: readonly SqlParam[] = []): SqlStatement {
  return {
    sql: `INSERT INTO wallet_allocation_guards (id,valid) VALUES (?,CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
    params: [`plan_guard_${crypto.randomUUID()}`, ...params],
  };
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

/**
 * Forward-only extension. It deliberately has no grant writer and no fallback
 * to the pre-custody cancellation implementation. Public wiring requires the
 * original custody fence and historical-period verifier to be composed together.
 */
export function createSubscriptionPlanChanges(options: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly client: StripeBillingClient;
  readonly custody: SubscriptionPlanCustody;
  readonly realm: {
    readonly accountId: string;
    readonly livemode: false;
    readonly billingAuthority: string;
  };
  readonly qualifyPlan: (planKey: string) => Promise<QualifiedSubscriptionPlan>;
}) {
  const { sql, clock, client, custody } = options;
  if (
    !options.realm.accountId.startsWith("acct_") ||
    !options.realm.billingAuthority ||
    options.realm.livemode !== false
  )
    fail("unqualified_processor_realm", 503);
  const realm = JSON.parse(canonicalJson(options.realm)) as typeof options.realm;
  const now = () => clock().toISOString();
  const byCommand = async (org: string, ref: string): Promise<Command | null> => {
    const row = (
      await sql.query("SELECT * FROM stripe_billing_plan_changes WHERE org_id=? AND reference=?", [
        org,
        ref,
      ])
    )[0];
    return row ? commandFrom(row) : null;
  };
  const byStep = async (command: Command, step: string): Promise<Step | null> => {
    const row = (
      await sql.query(
        "SELECT * FROM stripe_billing_plan_change_steps WHERE org_id=? AND reference=? AND step=?",
        [command.organizationId, command.reference, step],
      )
    )[0];
    return row ? stepFrom(row) : null;
  };
  function targetGuard(target: SubscriptionPlanTarget): SqlStatement {
    const fence = custody.fence(target);
    if (!fence.condition) fail("subscription_custody_unavailable", 503);
    return guard(fence.condition, fence.params);
  }
  function slotGuard(command: Command): SqlStatement {
    return guard(
      "EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=? AND reference=?)",
      [command.organizationId, command.reference],
    );
  }
  async function batch(statements: readonly SqlStatement[]): Promise<void> {
    const ids = statements
      .filter((statement) => statement.sql.startsWith("INSERT INTO wallet_allocation_guards"))
      .map((statement) => statement.params?.[0] ?? null);
    await sql.batch([
      ...statements,
      {
        sql: `DELETE FROM wallet_allocation_guards WHERE id IN (${ids.map(() => "?").join(",")})`,
        params: ids,
      },
    ]);
  }
  async function original(subscriptionId: string): Promise<void> {
    const initial = await custody.originalTerms(subscriptionId);
    if (initial.terms.subscriptionId !== subscriptionId) fail("subscription_terms_conflict", 503);
    time(initial.effectiveAt);
    assertPlan(initial.terms);
    const bytes = canonicalJson(initial.terms);
    await sql.run(
      "INSERT OR IGNORE INTO stripe_billing_subscription_terms(subscription_id,effective_at,org_id,terms_json,command_reference) VALUES (?,?,?,?,NULL)",
      [subscriptionId, initial.effectiveAt, initial.terms.organizationId, bytes],
    );
    const row = (
      await sql.query(
        "SELECT terms_json,command_reference FROM stripe_billing_subscription_terms WHERE subscription_id=? AND effective_at=?",
        [subscriptionId, initial.effectiveAt],
      )
    )[0];
    if (!row || row.terms_json !== bytes || row.command_reference != null)
      fail("subscription_terms_conflict", 503);
  }
  async function verifyPeriodTerms(input: {
    readonly terms: SubscriptionPeriodTerms;
    readonly periodStart: string;
    readonly periodEnd: string;
  }): Promise<SubscriptionPeriodTerms> {
    time(input.periodStart);
    time(input.periodEnd);
    if (input.periodEnd <= input.periodStart) fail("invalid_period", 503);
    await original(input.terms.subscriptionId);
    const eligible = `NOT EXISTS(SELECT 1 FROM stripe_billing_subscription_term_revocations r
      WHERE r.subscription_id=t.subscription_id AND r.effective_at=t.effective_at
      AND r.released_at<t.effective_at)`;
    const row = (
      await sql.query(
        `SELECT terms_json,effective_at FROM stripe_billing_subscription_terms t
      WHERE subscription_id=? AND effective_at<=? AND ${eligible} ORDER BY effective_at DESC LIMIT 1`,
        [input.terms.subscriptionId, input.periodStart],
      )
    )[0];
    const crossing = await sql.query(
      `SELECT 1 FROM stripe_billing_subscription_terms t
      WHERE subscription_id=? AND effective_at>? AND effective_at<? AND ${eligible} LIMIT 1`,
      [input.terms.subscriptionId, input.periodStart, input.periodEnd],
    );
    if (!row || crossing.length || row.terms_json !== canonicalJson(input.terms))
      fail("subscription_terms_mismatch", 503);
    return json<SubscriptionPeriodTerms>(row.terms_json);
  }
  async function fingerprint(input: Record<string, unknown>): Promise<string> {
    return await bytesDigest(new TextEncoder().encode(canonicalJson([realm, input])));
  }
  async function retainedCommand(row: Row): Promise<Command> {
    const command = commandFrom(row),
      desired = object(json<unknown>(row.desired_json));
    const target = command.frozen.target;
    if (
      desired.organizationId !== command.organizationId ||
      desired.reference !== command.reference ||
      desired.kind !== command.kind ||
      desired.expectedSubscriptionRef !== target.subscriptionRef ||
      row.expected_subscription_ref !== target.subscriptionRef ||
      !TARGET_REF.test(target.subscriptionRef) ||
      target.terms.organizationId !== command.organizationId ||
      row.subscription_id !== target.terms.subscriptionId ||
      Number(row.expected_generation) !== target.generation ||
      !Number.isSafeInteger(target.generation) ||
      target.generation < 0 ||
      target.periodStart >= target.periodEnd ||
      !Number.isSafeInteger(target.billingCycleAnchor) ||
      target.billingCycleAnchor <= 0 ||
      !/^sub_[A-Za-z0-9_]+$/u.test(target.terms.subscriptionId) ||
      !/^cus_[A-Za-z0-9_]+$/u.test(target.terms.customerId) ||
      typeof target.cancelAtPeriodEnd !== "boolean" ||
      typeof target.unresolvedSettlement !== "boolean" ||
      command.fingerprint !== (await fingerprint(desired)) ||
      (command.state === "pending" && command.receipt !== null)
    )
      fail("subscription_command_unavailable", 503);
    time(target.periodStart);
    time(target.periodEnd);
    time(target.originalEffectiveAt);
    if (target.originalEffectiveAt > target.periodStart)
      fail("subscription_command_unavailable", 503);
    assertPlan(target.terms);
    const original = (
      await sql.query(
        `SELECT terms_json FROM stripe_billing_subscription_terms t
      WHERE subscription_id=? AND org_id=? AND effective_at<=?
      AND NOT EXISTS(SELECT 1 FROM stripe_billing_subscription_term_revocations r WHERE r.subscription_id=t.subscription_id AND r.effective_at=t.effective_at AND r.released_at<t.effective_at)
      ORDER BY effective_at DESC LIMIT 1`,
        [target.terms.subscriptionId, command.organizationId, target.periodStart],
      )
    )[0];
    if (original?.terms_json !== canonicalJson(target.terms))
      fail("subscription_command_unavailable", 503);
    if (command.kind === "plan-change") {
      const plan = command.frozen.plan;
      if (
        !plan ||
        plan.planKey !== desired.planKey ||
        command.frozen.effectiveAt !== target.periodEnd
      )
        fail("subscription_command_unavailable", 503);
      assertPlan(plan);
      if (command.state === "verified") {
        const receipt = command.receipt as SubscriptionPlanChangeReceipt | null;
        if (
          receipt?.state !== "verified" ||
          receipt.subscriptionRef !== target.subscriptionRef ||
          !("pendingChange" in receipt) ||
          canonicalJson(receipt.pendingChange) !==
            canonicalJson({
              planKey: plan.planKey,
              pricingRevision: plan.pricingRevision,
              effectiveAt: target.periodEnd,
            })
        )
          fail("subscription_command_unavailable", 503);
      }
    } else {
      if (
        !command.frozen.pendingReference ||
        !REF.test(command.frozen.pendingReference) ||
        !command.frozen.scheduleId ||
        !command.frozen.effectiveAt ||
        command.frozen.custodyRequestKeyDigest !==
          (
            await bytesDigest(
              new TextEncoder().encode(canonicalJson([command.organizationId, command.reference])),
            )
          ).slice("sha256:".length)
      )
        fail("subscription_command_unavailable", 503);
      time(command.frozen.effectiveAt);
      if (command.state === "verified") {
        const receipt = command.receipt as SubscriptionPlanCancellationReceipt | null;
        if (
          receipt?.state !== "verified" ||
          receipt.subscriptionRef !== target.subscriptionRef ||
          !("effectiveAt" in receipt)
        )
          fail("subscription_command_unavailable", 503);
        time(receipt.effectiveAt);
      }
    }
    return command;
  }
  async function readCommand(
    organizationId: string,
    reference: string,
    kind: "cancel" | "plan-change",
  ): Promise<SubscriptionExtensionCommandDescriptor | null> {
    if (
      typeof organizationId !== "string" ||
      !REF.test(organizationId) ||
      typeof reference !== "string" ||
      !REF.test(reference) ||
      (kind !== "cancel" && kind !== "plan-change")
    )
      fail("invalid_argument", 400);
    const row = (
      await sql.query(
        "SELECT * FROM stripe_billing_plan_changes WHERE org_id=? AND reference=? AND kind=?",
        [organizationId, reference, kind],
      )
    )[0];
    if (!row) return null;
    try {
      const command = await retainedCommand(row),
        target = command.frozen.target;
      let lifecycle: SubscriptionPlanCommandDescriptor["lifecycle"] =
        command.state === "pending" ? "pending" : "scheduled";
      const effectiveAt =
        kind === "plan-change"
          ? (command.frozen.effectiveAt ?? null)
          : command.state === "verified"
            ? (
                command.receipt as Extract<
                  SubscriptionPlanCancellationReceipt,
                  { state: "verified" }
                >
              ).effectiveAt
            : null;
      if (kind === "plan-change" && command.state === "verified") {
        const term = (
          await sql.query(
            "SELECT terms_json,command_reference FROM stripe_billing_subscription_terms WHERE subscription_id=? AND org_id=? AND effective_at=?",
            [target.terms.subscriptionId, organizationId, command.frozen.effectiveAt ?? null],
          )
        )[0];
        if (
          term?.command_reference !== reference ||
          term.terms_json !== canonicalJson({ ...target.terms, ...command.frozen.plan })
        )
          fail("subscription_command_unavailable", 503);
        const created = await byStep(command, "create");
        const expectedStep = async (owner: Command, name: string) => {
          const proof = await byStep(owner, name);
          if (proof?.state !== "verified") return null;
          const key = `takos-plan-${await fingerprint({ org: owner.organizationId, reference: owner.reference, step: name })}`;
          if (
            !created?.remoteId ||
            created.state !== "verified" ||
            proof.key !== key ||
            proof.remoteId !== created.remoteId ||
            proof.response?.id !== created.remoteId ||
            proof.response.livemode !== false ||
            id(proof.response.customer) !== target.terms.customerId ||
            canonicalJson(proof.request) !== canonicalJson({ preserve_cancel_date: "true" })
          )
            fail("subscription_command_unavailable", 503);
          return proof.response;
        };
        const activation = await expectedStep(command, "activation-release");
        let activated = false;
        if (activation) {
          if (
            !["released", "completed"].includes(String(activation.status)) ||
            activation.end_behavior !== "release" ||
            (activation.status === "released" &&
              id(activation.released_subscription) !== target.terms.subscriptionId) ||
            (activation.subscription != null &&
              id(activation.subscription) !== target.terms.subscriptionId)
          )
            fail("subscription_command_unavailable", 503);
          activated = true;
        }
        let revoked = false;
        const revocations = await sql.query(
          "SELECT reference,released_at FROM stripe_billing_subscription_term_revocations WHERE subscription_id=? AND org_id=? AND effective_at=?",
          [target.terms.subscriptionId, organizationId, command.frozen.effectiveAt ?? null],
        );
        for (const revocation of revocations) {
          const cancelRow = (
            await sql.query(
              "SELECT * FROM stripe_billing_plan_changes WHERE org_id=? AND reference=? AND kind='cancel'",
              [organizationId, String(revocation.reference)],
            )
          )[0];
          if (!cancelRow) fail("subscription_command_unavailable", 503);
          const cancel = await retainedCommand(cancelRow);
          if (
            cancel.frozen.pendingReference !== reference ||
            cancel.frozen.scheduleId !== created?.remoteId ||
            cancel.frozen.effectiveAt !== command.frozen.effectiveAt ||
            cancel.frozen.target.subscriptionRef !== target.subscriptionRef ||
            cancel.frozen.target.terms.subscriptionId !== target.terms.subscriptionId ||
            cancel.frozen.target.terms.customerId !== target.terms.customerId
          )
            fail("subscription_command_unavailable", 503);
          const release = await expectedStep(cancel, "release");
          if (
            release?.status !== "released" ||
            release.subscription != null ||
            id(release.released_subscription) !== target.terms.subscriptionId ||
            !Number.isSafeInteger(release.released_at) ||
            Number(release.released_at) <= 0 ||
            new Date(Number(release.released_at) * 1000).toISOString() !== revocation.released_at ||
            String(revocation.released_at) >= String(command.frozen.effectiveAt)
          )
            fail("subscription_command_unavailable", 503);
          revoked = true;
        }
        if (activated && revoked) fail("subscription_command_unavailable", 503);
        lifecycle = revoked ? "revoked" : activated ? "activated" : "scheduled";
      }
      const original = {
        organizationId,
        reference,
        state: command.state,
        subscriptionRef: target.subscriptionRef,
      };
      if (kind === "cancel")
        return {
          ...original,
          kind,
          planKey: target.terms.planKey,
          pricingRevision: target.terms.pricingRevision,
          effectiveAt,
          lifecycle: command.state === "pending" ? "pending" : "scheduled",
        };
      const plan = command.frozen.plan;
      if (!plan || !effectiveAt) fail("subscription_command_unavailable", 503);
      return {
        ...original,
        kind,
        planKey: plan.planKey,
        pricingRevision: plan.pricingRevision,
        effectiveAt,
        pendingChange:
          command.state === "verified"
            ? (command.receipt as Extract<SubscriptionPlanChangeReceipt, { state: "verified" }>)
                .pendingChange
            : null,
        lifecycle,
      };
    } catch (error) {
      if (error instanceof SubscriptionPlanChangeError) throw error;
      fail("subscription_command_unavailable", 503);
    }
  }
  function validateInput(input: {
    organizationId: string;
    reference: string;
    expectedSubscriptionRef: string;
  }): void {
    if (
      !input.organizationId ||
      !REF.test(input.reference) ||
      !TARGET_REF.test(input.expectedSubscriptionRef)
    )
      fail("invalid_argument", 400);
  }
  async function prepare(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly expectedSubscriptionRef: string;
    readonly kind: Command["kind"];
    readonly planKey?: string;
  }): Promise<Command> {
    validateInput(input);
    const desired = canonicalJson(input);
    const pin = await fingerprint(input);
    const prior = await byCommand(input.organizationId, input.reference);
    if (prior) {
      if (prior.fingerprint !== pin) fail("payment_command_conflict");
      return prior;
    }
    const target = await custody.readTarget(input.organizationId, input.expectedSubscriptionRef);
    if (
      target.subscriptionRef !== input.expectedSubscriptionRef ||
      target.terms.organizationId !== input.organizationId
    )
      fail("subscription_target_changed");
    if (input.kind === "plan-change" && target.unresolvedSettlement)
      fail("subscription_settlement_unresolved");
    time(target.periodStart);
    time(target.periodEnd);
    if (target.periodStart >= target.periodEnd || target.periodEnd <= now())
      fail("subscription_period_changed");
    if (
      !Number.isSafeInteger(target.generation) ||
      target.generation < 0 ||
      !Number.isSafeInteger(target.billingCycleAnchor)
    )
      fail("invalid_subscription_target", 503);
    const slot = (
      await sql.query("SELECT * FROM stripe_billing_plan_change_slots WHERE org_id=?", [
        input.organizationId,
      ])
    )[0];
    let frozen: Frozen;
    if (input.kind === "plan-change") {
      if (target.cancelAtPeriodEnd) fail("subscription_cancellation_scheduled");
      if (slot || target.scheduleId) fail("subscription_management_conflict");
      const plan = await options.qualifyPlan(input.planKey ?? "");
      assertPlan(plan);
      if (plan.planKey !== input.planKey) fail("unqualified_pricing_revision", 503);
      if (
        plan.planKey === target.terms.planKey &&
        plan.pricingRevision === target.terms.pricingRevision
      )
        fail("subscription_plan_unchanged");
      frozen = { target, plan, effectiveAt: target.periodEnd };
    } else {
      const pending = slot ? await byCommand(input.organizationId, String(slot.reference)) : null;
      if (pending?.kind !== "plan-change" || pending.state !== "verified")
        fail("no_verified_pending_plan_change");
      const created = await byStep(pending, "create");
      if (!created?.remoteId || target.scheduleId !== created.remoteId)
        fail("schedule_readback_mismatch", 503);
      frozen = {
        target,
        pendingReference: pending.reference,
        scheduleId: created.remoteId,
        effectiveAt: pending.frozen.effectiveAt ?? fail("payment_command_unavailable", 503),
        custodyRequestKeyDigest: (
          await bytesDigest(
            new TextEncoder().encode(canonicalJson([input.organizationId, input.reference])),
          )
        ).slice("sha256:".length),
      };
    }
    await original(target.terms.subscriptionId);
    await verifyPeriodTerms({
      terms: target.terms,
      periodStart: target.periodStart,
      periodEnd: target.periodEnd,
    });
    const generation = Number(slot?.generation ?? 0) + 1;
    try {
      await batch([
        targetGuard(target),
        guard(
          slot
            ? "EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=? AND reference=? AND generation=?)"
            : "NOT EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=?)",
          slot
            ? [input.organizationId, String(slot.reference), Number(slot.generation)]
            : [input.organizationId],
        ),
        {
          sql: `INSERT INTO stripe_billing_plan_changes(org_id,reference,fingerprint,kind,expected_subscription_ref,subscription_id,expected_generation,desired_json,frozen_json,state,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL,?)`,
          params: [
            input.organizationId,
            input.reference,
            pin,
            input.kind,
            input.expectedSubscriptionRef,
            target.terms.subscriptionId,
            target.generation,
            desired,
            canonicalJson(frozen),
            now(),
          ],
        },
        {
          sql: `INSERT INTO stripe_billing_plan_change_slots(org_id,reference,generation) VALUES(?,?,?) ON CONFLICT(org_id) DO UPDATE SET reference=excluded.reference,generation=excluded.generation`,
          params: [input.organizationId, input.reference, generation],
        },
      ]);
    } catch (error) {
      const committed = await byCommand(input.organizationId, input.reference);
      if (committed?.fingerprint === pin) return committed;
      if (committed) fail("payment_command_conflict");
      if (
        (
          await sql.query("SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=?", [
            input.organizationId,
          ])
        ).length
      )
        fail("subscription_management_conflict");
      throw error;
    }
    return (
      (await byCommand(input.organizationId, input.reference)) ??
      fail("payment_command_unavailable", 503)
    );
  }
  async function step(command: Command, name: string, form: Record<string, string>): Promise<Step> {
    const key = `takos-plan-${await fingerprint({ org: command.organizationId, reference: command.reference, step: name })}`;
    await sql.run(
      `INSERT OR IGNORE INTO stripe_billing_plan_change_steps(org_id,reference,step,request_json,idempotency_key,state,remote_id,response_json,created_at,dispatched_at,verified_at) VALUES(?,?,?,?,?,'prepared',NULL,NULL,?,NULL,NULL)`,
      [command.organizationId, command.reference, name, canonicalJson(form), key, now()],
    );
    const stored = await byStep(command, name);
    if (!stored || canonicalJson(stored.request) !== canonicalJson(form) || stored.key !== key)
      fail("payment_step_conflict");
    return stored;
  }
  async function claim(
    command: Command,
    name: string,
    currentTarget = command.frozen.target,
  ): Promise<boolean> {
    await custody.verifyTarget?.(currentTarget);
    if (name === "create" || name === "schedule") {
      if (currentTarget.periodEnd <= now()) fail("subscription_period_changed");
      const subscription = await readSubscription(currentTarget);
      assertCurrentTerms(subscription, currentTarget);
      const expectedSchedule =
        name === "create" ? null : (await byStep(command, "create"))?.remoteId;
      if (
        subscription.current_period_start !== Number(seconds(currentTarget.periodStart)) ||
        subscription.current_period_end !== Number(seconds(currentTarget.periodEnd)) ||
        subscription.cancel_at_period_end !== false ||
        id(subscription.schedule) !== expectedSchedule
      )
        fail("subscription_target_changed");
    }
    try {
      await batch([
        targetGuard(currentTarget),
        slotGuard(command),
        {
          sql: "UPDATE stripe_billing_plan_change_steps SET state='dispatched',dispatched_at=? WHERE org_id=? AND reference=? AND step=? AND state='prepared'",
          params: [now(), command.organizationId, command.reference, name],
        },
        guard("changes()=1"),
      ]);
      return true;
    } catch (error) {
      if ((await byStep(command, name))?.state !== "prepared") return false;
      throw error;
    }
  }
  async function locate(command: Command, name: string, remoteId: string): Promise<void> {
    const write = await sql.run(
      "UPDATE stripe_billing_plan_change_steps SET remote_id=? WHERE org_id=? AND reference=? AND step=? AND state='dispatched' AND remote_id IS NULL",
      [remoteId, command.organizationId, command.reference, name],
    );
    if (!write.changes && (await byStep(command, name))?.remoteId !== remoteId)
      fail("payment_step_conflict");
  }
  async function verified(
    command: Command,
    name: string,
    response: StripeBillingObject,
  ): Promise<void> {
    await custody.verifyTarget?.(command.frozen.target);
    await batch([
      slotGuard(command),
      {
        sql: "UPDATE stripe_billing_plan_change_steps SET state='verified',remote_id=?,response_json=?,verified_at=? WHERE org_id=? AND reference=? AND step=? AND state='dispatched' AND (remote_id IS NULL OR remote_id=?)",
        params: [
          response.id,
          canonicalJson(response),
          now(),
          command.organizationId,
          command.reference,
          name,
          response.id,
        ],
      },
      guard("changes()=1"),
    ]).catch(async (error) => {
      const stored = await byStep(command, name);
      if (stored?.state !== "verified" || stored.remoteId !== response.id) throw error;
    });
  }
  const pending = (command: Command) => ({
    state: "pending" as const,
    subscriptionRef: command.frozen.target.subscriptionRef,
  });
  async function finish(
    command: Command,
    receipt: NonNullable<Command["receipt"]>,
    extra: readonly SqlStatement[] = [],
  ): Promise<NonNullable<Command["receipt"]>> {
    await custody.verifyTarget?.(command.frozen.target);
    try {
      await batch([
        targetGuard(command.frozen.target),
        slotGuard(command),
        ...extra,
        {
          sql: "UPDATE stripe_billing_plan_changes SET state='verified',receipt_json=? WHERE org_id=? AND reference=? AND state='pending'",
          params: [canonicalJson(receipt), command.organizationId, command.reference],
        },
        guard("changes()=1"),
      ]);
    } catch (error) {
      const stored = await byCommand(command.organizationId, command.reference);
      if (stored?.receipt) return stored.receipt;
      throw error;
    }
    return receipt;
  }
  async function readSubscription(target: SubscriptionPlanTarget): Promise<StripeBillingObject> {
    const subscription = await client.get("subscriptions", target.terms.subscriptionId);
    if (
      subscription?.livemode !== false ||
      id(subscription.customer) !== target.terms.customerId ||
      subscription.billing_cycle_anchor !== target.billingCycleAnchor ||
      subscription.application != null ||
      subscription.on_behalf_of != null ||
      subscription.transfer_data != null
    )
      fail("subscription_target_changed", 503);
    await custody.verifyTarget?.(target);
    return subscription;
  }
  function assertCurrentTerms(
    subscription: StripeBillingObject,
    target: SubscriptionPlanTarget,
  ): void {
    const items = object(subscription.items);
    if (
      items.has_more !== false ||
      !Array.isArray(items.data) ||
      items.data.length !== 1 ||
      id(object(items.data[0]).price) !== target.terms.priceId ||
      object(items.data[0]).quantity !== 1 ||
      Object.entries(metadataFor(target.terms)).some(
        ([key, value]) => object(subscription.metadata)[key] !== value,
      )
    )
      fail("subscription_target_changed", 503);
  }
  async function resumeChange(command: Command): Promise<SubscriptionPlanChangeReceipt> {
    if (command.receipt) return command.receipt as SubscriptionPlanChangeReceipt;
    const { target, plan } = command.frozen;
    if (!plan) fail("payment_command_unavailable", 503);
    let created = await step(command, "create", { from_subscription: target.terms.subscriptionId });
    if (created.state === "prepared" && (await claim(command, "create"))) {
      try {
        const ack = await client.post("subscription_schedules", {
          form: created.request,
          idempotencyKey: created.key,
        });
        assertSchedule(ack, target);
        await locate(command, "create", ack.id);
      } catch {
        return pending(command);
      }
    }
    created = (await byStep(command, "create")) ?? created;
    if (created.state !== "verified") {
      const readback = created.remoteId
        ? await client.get("subscription_schedules", created.remoteId)
        : await custody.recoverCreatedSchedule({
            organizationId: command.organizationId,
            reference: command.reference,
            subscriptionId: target.terms.subscriptionId,
            idempotencyKey: created.key,
          });
      if (!readback) return pending(command);
      assertSchedule(readback, target);
      await verified(command, "create", readback);
      created = (await byStep(command, "create")) ?? fail("payment_step_unavailable", 503);
    }
    const scheduleId = created.remoteId ?? fail("payment_step_unavailable", 503);
    const before = created.response ?? fail("payment_step_unavailable", 503);
    const phases = before.phases as readonly unknown[];
    if (phases.length !== 1) fail("unsupported_schedule_settings");
    const current = phaseSettings(object(phases[0]), target);
    const desiredTerms: SubscriptionPeriodTerms = { ...target.terms, ...plan };
    const form: Record<string, string> = {
      end_behavior: "release",
      proration_behavior: "none",
      "metadata[takoserverPlanCommand]": command.fingerprint,
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
          { ...object((current.items as readonly Json[])[0]), price: plan.priceId, quantity: 1 },
        ] as Json,
        metadata: { ...object(current.metadata), ...metadataFor(desiredTerms) } as Json,
        start_date: Number(seconds(target.periodEnd)),
        end_date: nextMonthlyBoundary(target.periodEnd, target.billingCycleAnchor),
        proration_behavior: "none",
      },
      "phases[1]",
      form,
    );
    let update = await step(command, "schedule", form);
    if (update.state === "prepared" && (await claim(command, "schedule"))) {
      try {
        await client.post("subscription_schedules", {
          id: scheduleId,
          form: update.request,
          idempotencyKey: update.key,
        });
      } catch {
        return pending(command);
      }
    }
    update = (await byStep(command, "schedule")) ?? update;
    if (update.state !== "verified") {
      const readback = await client.get("subscription_schedules", scheduleId);
      if (!readback) return pending(command);
      assertSchedule(readback, target, true);
      const scheduledPhases = readback.phases as readonly unknown[];
      const first = object(scheduledPhases[0]);
      const future = object(scheduledPhases[1]);
      const futureItems = future.items;
      const expectedCurrent = {
        ...current,
        start_date: Number(seconds(target.periodStart)),
        end_date: Number(seconds(target.periodEnd)),
        proration_behavior: "none",
      };
      const actualCurrent = {
        ...phaseSettings(first, target),
        start_date: first.start_date,
        end_date: first.end_date,
        proration_behavior: first.proration_behavior,
      };
      const expectedFutureSettings = {
        ...current,
        items: [
          { ...object((current.items as readonly Json[])[0]), price: plan.priceId, quantity: 1 },
        ],
        metadata: { ...object(current.metadata), ...metadataFor(desiredTerms) },
      };
      const actualFutureSettings = phaseSettings(future, {
        ...target,
        terms: desiredTerms,
        periodStart: target.periodEnd,
      });
      if (
        readback.end_behavior !== "release" ||
        object(readback.metadata).takoserverPlanCommand !== command.fingerprint ||
        scheduledPhases.length !== 2 ||
        canonicalJson(actualCurrent) !== canonicalJson(expectedCurrent) ||
        future.start_date !== Number(seconds(target.periodEnd)) ||
        future.end_date !== nextMonthlyBoundary(target.periodEnd, target.billingCycleAnchor) ||
        future.proration_behavior !== "none" ||
        future.billing_cycle_anchor === "phase_start" ||
        !Array.isArray(futureItems) ||
        futureItems.length !== 1 ||
        id(object(futureItems[0]).price) !== plan.priceId ||
        object(futureItems[0]).quantity !== 1 ||
        Object.entries(metadataFor(desiredTerms)).some(
          ([key, value]) => object(future.metadata)[key] !== value,
        ) ||
        canonicalJson(readback.default_settings) !== canonicalJson(before.default_settings) ||
        canonicalJson(actualFutureSettings) !== canonicalJson(expectedFutureSettings)
      )
        fail("schedule_readback_mismatch", 503);
      const subscription = await readSubscription(target);
      const periodStart = Number(subscription.current_period_start);
      const periodEnd = Number(subscription.current_period_end);
      if (
        periodStart === Number(seconds(target.periodStart)) &&
        periodEnd === Number(seconds(target.periodEnd))
      ) {
        assertCurrentTerms(subscription, target);
        if (subscription.cancel_at_period_end !== false || id(subscription.schedule) !== scheduleId)
          fail("subscription_target_changed", 503);
      } else {
        if (
          !Number.isSafeInteger(periodStart) ||
          !Number.isSafeInteger(periodEnd) ||
          periodEnd <= periodStart ||
          periodStart < Number(seconds(target.periodEnd)) ||
          (subscription.schedule != null && id(subscription.schedule) !== scheduleId)
        )
          fail("subscription_target_changed", 503);
        assertCurrentTerms(subscription, { ...target, terms: desiredTerms });
      }
      await verified(command, "schedule", readback);
    }
    const receipt: SubscriptionPlanChangeReceipt = {
      state: "verified",
      subscriptionRef: target.subscriptionRef,
      pendingChange: {
        planKey: plan.planKey,
        pricingRevision: plan.pricingRevision,
        effectiveAt: target.periodEnd,
      },
    };
    return (await finish(command, receipt, [
      {
        sql: "INSERT INTO stripe_billing_subscription_terms(subscription_id,effective_at,org_id,terms_json,command_reference) VALUES(?,?,?,?,?)",
        params: [
          target.terms.subscriptionId,
          target.periodEnd,
          command.organizationId,
          canonicalJson(desiredTerms),
          command.reference,
        ],
      },
    ])) as SubscriptionPlanChangeReceipt;
  }
  async function resumeCancel(command: Command): Promise<SubscriptionPlanCancellationReceipt> {
    if (command.receipt) return command.receipt as SubscriptionPlanCancellationReceipt;
    const { target, scheduleId, effectiveAt } = command.frozen;
    if (!scheduleId || !effectiveAt) fail("payment_command_unavailable", 503);
    let release = await step(command, "release", { preserve_cancel_date: "true" });
    if (release.state === "prepared" && (await claim(command, "release"))) {
      try {
        await client.post("subscription_schedules", {
          id: scheduleId,
          action: "release",
          form: release.request,
          idempotencyKey: release.key,
        });
      } catch {
        return pending(command);
      }
    }
    release = (await byStep(command, "release")) ?? release;
    if (release.state !== "verified") {
      const schedule = await client.get("subscription_schedules", scheduleId);
      if (schedule?.status !== "released") return pending(command);
      if (
        schedule.livemode !== false ||
        id(schedule.released_subscription) !== target.terms.subscriptionId ||
        schedule.subscription != null ||
        id(schedule.customer) !== target.terms.customerId ||
        !Number.isSafeInteger(schedule.released_at) ||
        Number(schedule.released_at) <= 0
      )
        fail("schedule_release_mismatch", 503);
      const subscription = await readSubscription(target);
      if (
        subscription.schedule != null ||
        ["canceled", "incomplete_expired"].includes(String(subscription.status))
      )
        fail("schedule_release_mismatch", 503);
      await verified(command, "release", schedule);
      release = (await byStep(command, "release")) ?? release;
    }
    const proof = release.response ?? fail("payment_step_unavailable", 503);
    const releasedAt = new Date(Number(proof.released_at) * 1000).toISOString();
    if (releasedAt < effectiveAt)
      await sql.run(
        "INSERT OR IGNORE INTO stripe_billing_subscription_term_revocations(subscription_id,effective_at,org_id,reference,released_at,created_at) VALUES(?,?,?,?,?,?)",
        [
          target.terms.subscriptionId,
          effectiveAt,
          command.organizationId,
          command.reference,
          releasedAt,
          now(),
        ],
      );
    // The original cancellation custody owns dispatch and GET-only recovery.
    // Repeated calls use its same immutable reference and target, never false.
    const receipt = await custody.cancel({
      organizationId: command.organizationId,
      reference: command.reference,
      expectedSubscriptionRef: target.subscriptionRef,
      cancelAtPeriodEnd: true,
    });
    if (receipt.subscriptionRef !== target.subscriptionRef)
      fail("subscription_target_changed", 503);
    if (receipt.state === "pending") return receipt;
    return (await finish(command, receipt)) as SubscriptionPlanCancellationReceipt;
  }
  async function reconcileActivation(
    organizationId: string,
    expectedSubscriptionRef: string,
  ): Promise<{ readonly completed: boolean }> {
    const slot = (
      await sql.query("SELECT reference FROM stripe_billing_plan_change_slots WHERE org_id=?", [
        organizationId,
      ])
    )[0];
    if (!slot) return { completed: true };
    const command = await byCommand(organizationId, String(slot.reference));
    if (command?.kind !== "plan-change" || command.state !== "verified")
      return { completed: false };
    if (command.frozen.target.subscriptionRef !== expectedSubscriptionRef)
      fail("subscription_target_changed");
    const target = await custody.readTarget(organizationId, expectedSubscriptionRef);
    const { plan, effectiveAt } = command.frozen;
    if (!plan || !effectiveAt || target.periodStart < effectiveAt) return { completed: false };
    if (
      target.terms.subscriptionId !== command.frozen.target.terms.subscriptionId ||
      target.generation !== command.frozen.target.generation ||
      canonicalJson(target.terms) !== canonicalJson({ ...command.frozen.target.terms, ...plan })
    )
      fail("subscription_target_changed");
    await verifyPeriodTerms({
      terms: target.terms,
      periodStart: target.periodStart,
      periodEnd: target.periodEnd,
    });
    const subscription = await readSubscription(target);
    assertCurrentTerms(subscription, target);
    const created = await byStep(command, "create");
    const scheduleId = created?.remoteId ?? fail("payment_step_unavailable", 503);
    if (subscription.schedule != null && id(subscription.schedule) !== scheduleId)
      fail("subscription_target_changed", 503);
    let release = await step(command, "activation-release", { preserve_cancel_date: "true" });
    if (release.state === "prepared" && (await claim(command, "activation-release", target))) {
      if (subscription.schedule != null) {
        try {
          await client.post("subscription_schedules", {
            id: scheduleId,
            action: "release",
            form: release.request,
            idempotencyKey: release.key,
          });
        } catch {
          return { completed: false };
        }
      }
    }
    release = (await byStep(command, "activation-release")) ?? release;
    if (release.state !== "verified") {
      const schedule = await client.get("subscription_schedules", scheduleId);
      const current = await readSubscription(target);
      assertCurrentTerms(current, target);
      if (
        schedule == null ||
        !["released", "completed"].includes(String(schedule.status)) ||
        current.schedule != null
      )
        return { completed: false };
      if (
        schedule.livemode !== false ||
        id(schedule.customer) !== target.terms.customerId ||
        schedule.end_behavior !== "release" ||
        (schedule.status === "released" &&
          id(schedule.released_subscription) !== target.terms.subscriptionId)
      )
        fail("schedule_release_mismatch", 503);
      await verified(command, "activation-release", schedule);
    }
    await batch([
      targetGuard(target),
      slotGuard(command),
      {
        sql: "DELETE FROM stripe_billing_plan_change_slots WHERE org_id=? AND reference=?",
        params: [organizationId, command.reference],
      },
      guard("changes()=1"),
    ]).catch(async (error) => {
      if (
        (
          await sql.query(
            "SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=? AND reference=?",
            [organizationId, command.reference],
          )
        ).length
      )
        throw error;
    });
    return { completed: true };
  }
  async function reconcilePending(limit = 20): Promise<{
    readonly examined: number;
    readonly applied: number;
    readonly unresolved: number;
    readonly truncated: boolean;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) fail("invalid_argument", 400);
    const stream = "subscription-plan-extensions";
    await sql.run(
      "INSERT OR IGNORE INTO stripe_billing_reconcile(stream,cursor,generation,cycle_unresolved,last_unresolved,cycle_started_at,updated_at) VALUES(?,NULL,0,0,0,?,?)",
      [stream, now(), now()],
    );
    const checkpoint = (
      await sql.query(
        "SELECT cursor,generation,cycle_unresolved FROM stripe_billing_reconcile WHERE stream=?",
        [stream],
      )
    )[0];
    if (!checkpoint) fail("payment_reconciliation_unavailable", 503);
    const cursor = checkpoint.cursor == null ? null : String(checkpoint.cursor);
    const after = cursor == null ? null : json<{ org: string; reference: string }>(cursor);
    if (after && (typeof after.org !== "string" || typeof after.reference !== "string"))
      fail("payment_reconciliation_unavailable", 503);
    const rows = await sql.query(
      `SELECT c.* FROM stripe_billing_plan_change_slots s JOIN stripe_billing_plan_changes c
      ON c.org_id=s.org_id AND c.reference=s.reference
      WHERE (? IS NULL OR c.org_id>? OR (c.org_id=? AND c.reference>?))
      ORDER BY c.org_id,c.reference LIMIT ?`,
      [
        after?.org ?? null,
        after?.org ?? null,
        after?.org ?? null,
        after?.reference ?? null,
        limit + 1,
      ],
    );
    let applied = 0,
      unresolved = 0;
    for (const row of rows.slice(0, limit)) {
      try {
        const command = commandFrom(row);
        if (command.state === "pending") {
          const receipt =
            command.kind === "plan-change"
              ? await resumeChange(command)
              : await resumeCancel(command);
          if (receipt.state === "verified") applied++;
          else unresolved++;
        } else if (command.kind === "plan-change") {
          if (command.frozen.effectiveAt && command.frozen.effectiveAt <= now()) {
            if (
              (
                await reconcileActivation(
                  command.organizationId,
                  command.frozen.target.subscriptionRef,
                )
              ).completed
            )
              applied++;
            else unresolved++;
          }
        } else {
          const subscription = await readSubscription(command.frozen.target);
          if (["canceled", "incomplete_expired"].includes(String(subscription.status))) {
            await batch([
              slotGuard(command),
              {
                sql: "DELETE FROM stripe_billing_plan_change_slots WHERE org_id=? AND reference=?",
                params: [command.organizationId, command.reference],
              },
              guard("changes()=1"),
            ]);
            applied++;
          }
        }
      } catch {
        unresolved++;
      }
    }
    const truncated = rows.length > limit;
    const last = rows.slice(0, limit).at(-1);
    const next =
      truncated && last
        ? canonicalJson({ org: String(last.org_id), reference: String(last.reference) })
        : null;
    const cycleUnresolved = Number(checkpoint.cycle_unresolved) + unresolved;
    const write = await sql.run(
      `UPDATE stripe_billing_reconcile SET cursor=?,generation=generation+1,
      cycle_unresolved=?,last_unresolved=CASE WHEN ? IS NULL THEN ? ELSE last_unresolved END,
      cycle_started_at=CASE WHEN ? IS NULL THEN ? ELSE cycle_started_at END,updated_at=?
      WHERE stream=? AND cursor IS ? AND generation=?`,
      [
        next,
        truncated ? cycleUnresolved : 0,
        next,
        cycleUnresolved,
        next,
        now(),
        now(),
        stream,
        cursor,
        Number(checkpoint.generation),
      ],
    );
    if (write.changes !== 1) fail("payment_reconciliation_conflict", 503);
    return {
      examined: Math.min(rows.length, limit),
      applied,
      unresolved: cycleUnresolved,
      truncated,
    };
  }
  return {
    readCommand,
    verifyPeriodTerms,
    reconcileActivation,
    reconcilePending,
    async pending(organizationId: string): Promise<{
      readonly planKey: string;
      readonly pricingRevision: string;
      readonly effectiveAt: string;
    } | null> {
      const slot = (
        await sql.query("SELECT reference FROM stripe_billing_plan_change_slots WHERE org_id=?", [
          organizationId,
        ])
      )[0];
      if (!slot) return null;
      let command = await byCommand(organizationId, String(slot.reference));
      if (command?.kind === "cancel") {
        if (
          command.state === "verified" ||
          (await byStep(command, "release"))?.state === "verified"
        )
          return null;
        command = command.frozen.pendingReference
          ? await byCommand(organizationId, command.frozen.pendingReference)
          : null;
      }
      if (command?.kind !== "plan-change" || command.state !== "verified") return null;
      const receipt = command.receipt as SubscriptionPlanChangeReceipt;
      if (receipt.state !== "verified") return null;
      const target = await custody.readTarget(
        organizationId,
        command.frozen.target.subscriptionRef,
      );
      const desired = { ...command.frozen.target.terms, ...command.frozen.plan };
      if (
        target.periodStart >= receipt.pendingChange.effectiveAt &&
        canonicalJson(target.terms) === canonicalJson(desired)
      ) {
        await verifyPeriodTerms({
          terms: target.terms,
          periodStart: target.periodStart,
          periodEnd: target.periodEnd,
        });
        return null;
      }
      return receipt.pendingChange;
    },
    async change(input: {
      readonly organizationId: string;
      readonly reference: string;
      readonly expectedSubscriptionRef: string;
      readonly planKey: string;
    }): Promise<SubscriptionPlanChangeReceipt> {
      return await resumeChange(await prepare({ ...input, kind: "plan-change" }));
    },
    async cancelPendingChange(input: {
      readonly organizationId: string;
      readonly reference: string;
      readonly expectedSubscriptionRef: string;
    }): Promise<SubscriptionPlanCancellationReceipt> {
      return await resumeCancel(await prepare({ ...input, kind: "cancel" }));
    },
    async lookup(organizationId: string, reference: string): Promise<Command["receipt"]> {
      const command = await byCommand(organizationId, reference);
      return command ? (command.receipt ?? pending(command)) : null;
    },
  };
}
