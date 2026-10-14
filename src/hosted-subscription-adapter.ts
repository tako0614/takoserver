import { MIGRATIONS } from "./db-schema.ts";
import {
  assertHostedBillingFinancialRealm,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import { canonicalJson } from "./json.ts";
import type { Sql } from "./ports.ts";
import {
  assertStripeBillingSubscriptionExtensionContext,
  type StripeBillingSubscriptionExtensionContext,
  type StripeBillingSubscriptionExtensions,
} from "./stripe-billing.ts";
import type { StripeBillingObject } from "./stripe-billing-client.ts";
import {
  createSubscriptionPlanChanges,
  type SubscriptionPeriodTerms,
  SubscriptionPlanChangeError,
  type SubscriptionPlanCustody,
} from "./stripe-subscription-plan-change.ts";
import type {
  Association,
  SubscriptionManagementContext,
  SubscriptionManagementPredicate,
} from "./subscription-custody.ts";

const PURPOSE = "hosted_subscription";

/** Startup qualification reads the additive schema; it never creates or repairs it. */
export async function assertHostedSubscriptionAdapterSchema(sql: Sql): Promise<void> {
  const tables = {
    stripe_billing_subscription_terms: [
      "subscription_id",
      "effective_at",
      "org_id",
      "terms_json",
      "command_reference",
    ],
    stripe_billing_subscription_term_revocations: [
      "subscription_id",
      "effective_at",
      "org_id",
      "reference",
      "released_at",
      "created_at",
    ],
    stripe_billing_plan_changes: [
      "org_id",
      "reference",
      "fingerprint",
      "kind",
      "expected_subscription_ref",
      "subscription_id",
      "expected_generation",
      "desired_json",
      "frozen_json",
      "state",
      "receipt_json",
      "created_at",
    ],
    stripe_billing_plan_change_slots: ["org_id", "reference", "generation"],
    stripe_billing_plan_change_steps: [
      "org_id",
      "reference",
      "step",
      "request_json",
      "idempotency_key",
      "state",
      "remote_id",
      "response_json",
      "created_at",
      "dispatched_at",
      "verified_at",
    ],
  } as const;
  const triggers = [
    "stripe_billing_subscription_terms_no_update",
    "stripe_billing_subscription_terms_no_delete",
    "stripe_billing_subscription_terms_org_insert",
    "stripe_billing_subscription_term_revocations_no_update",
    "stripe_billing_subscription_term_revocations_no_delete",
    "stripe_billing_subscription_term_revocations_owner_insert",
    "stripe_billing_plan_changes_immutable",
    "stripe_billing_plan_changes_no_delete",
    "stripe_billing_plan_change_steps_immutable",
    "stripe_billing_plan_change_steps_no_delete",
  ];
  for (const [table, required] of Object.entries(tables)) {
    const columns = new Set(
      (await sql.query(`PRAGMA table_info(${table})`)).map((row) => String(row.name)),
    );
    if (required.some((name) => !columns.has(name))) fail("billing_schema_not_ready", 503);
  }
  const found = new Set(
    (await sql.query("SELECT name FROM sqlite_master WHERE type='trigger'")).map((row) =>
      String(row.name),
    ),
  );
  if (triggers.some((name) => !found.has(name))) fail("billing_schema_not_ready", 503);
  const migration = MIGRATIONS.find((item) => item.name === "0099_hosted_billing_extensions.sql");
  if (!migration) fail("billing_schema_not_ready", 503);
  const normalize = (definition: string) =>
    definition.trim().replace(/;$/u, "").replace(/\s+/gu, " ");
  for (const [type, names] of [
    ["table", Object.keys(tables)],
    ["trigger", triggers],
  ] as const) {
    for (const name of names) {
      const pattern =
        type === "table"
          ? `CREATE TABLE ${name}\\s*\\([\\s\\S]*?\\n\\);`
          : `CREATE TRIGGER ${name}\\b[\\s\\S]*?\\bEND\\s*;`;
      const expected = migration.sql.match(new RegExp(pattern, "u"))?.[0];
      const actual = (
        await sql.query("SELECT sql FROM sqlite_master WHERE type=? AND name=?", [type, name])
      )[0]?.sql;
      if (!expected || typeof actual !== "string" || normalize(actual) !== normalize(expected))
        fail("billing_schema_not_ready", 503);
    }
  }
}
function fail(code: string, status = 409): never {
  throw new SubscriptionPlanChangeError(code, status);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_subscription", 503);
  return value as Record<string, unknown>;
}
function id(value: unknown): string | null {
  return typeof value === "string"
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? String((value as Record<string, unknown>).id ?? "") || null
      : null;
}
function instant(value: unknown): string {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 253402300799)
    fail("invalid_period", 503);
  return new Date(Number(value) * 1000).toISOString();
}
function noConnect(value: Record<string, unknown>): void {
  if (
    value.application != null ||
    value.on_behalf_of != null ||
    value.transfer_data != null ||
    value.account != null
  )
    fail("wrong_account", 503);
}
function initialTerms(bound: Association): SubscriptionPeriodTerms {
  return {
    organizationId: bound.organizationId,
    subscriptionId: bound.subscriptionId,
    customerId: bound.customerId,
    planKey: bound.planKey,
    pricingRevision: bound.pricingRevision,
    priceId: bound.priceId,
    priceAmountMinor: bound.priceAmountMinor,
    includedMinor: bound.includedMinor,
  };
}

/**
 * The existing writer owns the only canonical custody factory and grant writer.
 * This adapter can consume only its exact SQL/client/clock-bound context and the
 * same authenticated realm. It adds commercial period proofs, not an ownership
 * association, a second cancellation dispatcher, or a wallet writer.
 */
export function createHostedSubscriptionAdapter(options: {
  readonly context: StripeBillingSubscriptionExtensionContext;
  readonly realm: HostedBillingFinancialRealm;
}): StripeBillingSubscriptionExtensions {
  const { context, realm } = options;
  assertStripeBillingSubscriptionExtensionContext(context);
  if (context.realm !== realm) fail("financial_realm_unqualified", 503);
  const { sql, client, clock, custody } = context;
  const qualified = () =>
    assertHostedBillingFinancialRealm(realm, {
      sql,
      client,
      billingAuthority: realm.billingAuthority,
    });
  qualified();
  let plans: ReturnType<typeof createSubscriptionPlanChanges>;

  async function ownership(subscriptionId: string): Promise<Association> {
    qualified();
    const bound = await custody.association(subscriptionId);
    if (!bound || bound.subscriptionId !== subscriptionId || bound.livemode !== false)
      fail("unbound_subscription", 503);
    await context.boundCustomer(bound.organizationId, bound.customerId);
    return bound;
  }
  function subscriptionIdentity(
    sub: StripeBillingObject,
    bound: Association,
  ): { periodStart: string; periodEnd: string } {
    noConnect(sub);
    const meta = object(sub.metadata),
      items = object(sub.items);
    if (
      sub.object !== "subscription" ||
      sub.id !== bound.subscriptionId ||
      sub.livemode !== false ||
      id(sub.customer) !== bound.customerId ||
      sub.currency !== "usd" ||
      meta.organizationId !== bound.organizationId ||
      meta.takoserverPurpose !== PURPOSE ||
      items.has_more !== false ||
      !Array.isArray(items.data) ||
      items.data.length !== 1 ||
      object(items.data[0]).quantity !== 1 ||
      typeof sub.cancel_at_period_end !== "boolean"
    )
      fail("unbound_subscription", 503);
    const periodStart = instant(sub.current_period_start),
      periodEnd = instant(sub.current_period_end);
    if (periodStart >= periodEnd) fail("invalid_period", 503);
    return { periodStart, periodEnd };
  }
  async function originalTerms(subscriptionId: string) {
    const bound = await ownership(subscriptionId);
    const sub = await client.get("subscriptions", subscriptionId);
    if (!sub) fail("unknown_subscription", 503);
    subscriptionIdentity(sub, bound);
    const effectiveAt = instant(sub.start_date);
    const checkout = await client.get("checkout/sessions", bound.sessionId);
    if (!checkout) fail("subscription_checkout_unresolved", 503);
    noConnect(checkout);
    if (
      checkout.object !== "checkout.session" ||
      checkout.livemode !== false ||
      checkout.mode !== "subscription" ||
      id(checkout.subscription) !== bound.subscriptionId ||
      id(checkout.customer) !== bound.customerId ||
      effectiveAt < instant(checkout.created)
    )
      fail("subscription_checkout_mismatch", 503);
    const original = await context.planForRevision(bound.planKey, bound.pricingRevision);
    if (
      original.priceId !== bound.priceId ||
      original.priceAmountMinor !== bound.priceAmountMinor ||
      original.includedMinor !== bound.includedMinor
    )
      fail("subscription_terms_conflict", 503);
    return { terms: initialTerms(bound), effectiveAt };
  }
  async function resolveCurrentTerms(
    input: Parameters<StripeBillingSubscriptionExtensions["resolveCurrentTerms"]>[0],
  ): Promise<SubscriptionPeriodTerms> {
    const bound = await ownership(input.association.subscriptionId);
    if (canonicalJson(bound) !== canonicalJson(input.association))
      fail("subscription_target_changed", 503);
    const period = subscriptionIdentity(input.subscription, bound);
    if (period.periodStart !== input.periodStart || period.periodEnd !== input.periodEnd)
      fail("invalid_period", 503);
    const meta = object(input.subscription.metadata),
      items = object(input.subscription.items);
    if (typeof meta.planKey !== "string" || typeof meta.pricingRevision !== "string")
      fail("subscription_terms_mismatch", 503);
    const plan = await context.planForRevision(meta.planKey, meta.pricingRevision);
    if (id(object((items.data as readonly unknown[])[0]).price) !== plan.priceId)
      fail("wrong_price", 503);
    const terms = { ...initialTerms(bound), ...plan };
    return await plans.verifyPeriodTerms({ terms, ...period });
  }

  // The same existing pending rows fence all subscription commands. A release
  // saga may delegate only its own canonical cancellation key after verified
  // release. No independent Org association or generic slot authority is minted.
  const releasedCancellation = `EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots s
      JOIN stripe_billing_plan_changes c ON c.org_id=s.org_id AND c.reference=s.reference
      JOIN stripe_billing_plan_change_steps step ON step.org_id=c.org_id AND step.reference=c.reference
      WHERE s.org_id=? AND c.kind='cancel' AND c.subscription_id IS ?
        AND json_extract(c.frozen_json,'$.custodyRequestKeyDigest')=?
        AND step.step='release' AND step.state='verified')`;
  function managementGuard(input: SubscriptionManagementContext): SubscriptionManagementPredicate {
    qualified();
    const common = `NOT EXISTS(SELECT 1 FROM stripe_billing_customer_commands WHERE org_id=? AND state<>'verified')`;
    if (input.operation === "begin")
      return {
        condition: `${common} AND NOT EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=?) AND NOT EXISTS(SELECT 1 FROM stripe_subscription_cancellation_intents WHERE org_id=? AND state IN ('prepared','dispatched'))`,
        params: [input.organizationId, input.organizationId, input.organizationId],
      };
    return {
      condition: `${common} AND NOT EXISTS(SELECT 1 FROM stripe_subscription_checkout_intents WHERE org_id=? AND state IN ('prepared','dispatched','session_known')) AND (NOT EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots WHERE org_id=?) OR ${releasedCancellation})`,
      params: [
        input.organizationId,
        input.organizationId,
        input.organizationId,
        input.organizationId,
        input.subscriptionId ?? null,
        input.requestKeyDigest,
      ],
    };
  }
  const extensionCustody: SubscriptionPlanCustody = {
    async verifyTarget(target) {
      const bound = await ownership(target.terms.subscriptionId);
      const row = (
        await sql.query(
          "SELECT association_generation FROM stripe_billing_associations WHERE subscription_id=? AND org_id=? AND association_generation=(SELECT MAX(association_generation) FROM stripe_billing_associations WHERE org_id=?)",
          [bound.subscriptionId, target.terms.organizationId, target.terms.organizationId],
        )
      )[0];
      if (
        bound.organizationId !== target.terms.organizationId ||
        bound.customerId !== target.terms.customerId ||
        bound.livemode !== false ||
        Number(row?.association_generation) !== target.generation ||
        (await custody.subscriptionRef(bound)) !== target.subscriptionRef
      )
        fail("subscription_target_changed", 503);
    },
    originalTerms,
    async readTarget(organizationId, expectedSubscriptionRef) {
      await context.ready();
      qualified();
      const row = (
        await sql.query(
          `SELECT s.*,a.association_generation FROM stripe_billing_subscriptions s
        JOIN stripe_billing_associations a ON a.subscription_id=s.subscription_id
        WHERE s.org_id=? AND a.association_generation=(SELECT MAX(association_generation) FROM stripe_billing_associations WHERE org_id=?)`,
          [organizationId, organizationId],
        )
      )[0];
      if (!row) fail("subscription_management_not_found", 404);
      const bound = await ownership(String(row.subscription_id));
      const ref = await custody.subscriptionRef(bound);
      if (
        bound.organizationId !== organizationId ||
        bound.customerId !== row.customer_id ||
        ref !== expectedSubscriptionRef
      )
        fail("subscription_target_changed");
      const sub = await client.get("subscriptions", bound.subscriptionId);
      if (!sub) fail("unknown_subscription", 503);
      const period = subscriptionIdentity(sub, bound);
      if (!["active", "past_due", "unpaid", "paused", "trialing"].includes(String(sub.status)))
        fail("subscription_management_conflict");
      const terms = await resolveCurrentTerms({ association: bound, subscription: sub, ...period });
      const scheduleId = id(sub.schedule);
      if (scheduleId) {
        const owned = await sql.query(
          `SELECT 1 FROM stripe_billing_plan_change_steps step JOIN stripe_billing_plan_changes c ON c.org_id=step.org_id AND c.reference=step.reference
          WHERE c.org_id=? AND c.subscription_id=? AND c.kind='plan-change' AND step.step='create' AND step.state='verified' AND step.remote_id=? LIMIT 1`,
          [organizationId, bound.subscriptionId, scheduleId],
        );
        if (!owned.length) fail("unowned_subscription_schedule", 503);
      }
      if (!Number.isSafeInteger(sub.billing_cycle_anchor) || Number(sub.billing_cycle_anchor) <= 0)
        fail("invalid_subscription", 503);
      const settlement = (
        await sql.query(
          `SELECT
        (SELECT COALESCE(MAX(g.period_end),'') FROM stripe_billing_grants g WHERE g.org_id=? AND g.subscription_id=? AND g.source_type='invoice'
          AND g.period_start<=? AND NOT EXISTS(SELECT 1 FROM stripe_billing_refunds r WHERE r.org_id=g.org_id AND r.funding_ref=g.funding_ref AND r.cumulative_refunded_micros>=g.consideration_micros)) AS coverage,
        (SELECT COALESCE(SUM(receivable_micros),0) FROM stripe_billing_refunds WHERE org_id=?) AS debt`,
          [organizationId, bound.subscriptionId, period.periodStart, organizationId],
        )
      )[0];
      const initial = await originalTerms(bound.subscriptionId);
      return {
        subscriptionRef: ref,
        generation: Number(row.association_generation),
        terms,
        originalEffectiveAt: initial.effectiveAt,
        ...period,
        billingCycleAnchor: Number(sub.billing_cycle_anchor),
        cancelAtPeriodEnd: sub.cancel_at_period_end as boolean,
        unresolvedSettlement:
          sub.status !== "active" ||
          Number(settlement?.debt ?? 0) > 0 ||
          String(settlement?.coverage ?? "") < period.periodEnd,
        scheduleId,
      };
    },
    fence(target) {
      qualified();
      return {
        condition: `EXISTS(SELECT 1 FROM stripe_billing_associations a JOIN stripe_billing_subscriptions s ON s.org_id=a.org_id AND s.subscription_id=a.subscription_id JOIN stripe_billing_customers customer ON customer.org_id=a.org_id AND customer.customer_id=a.customer_id
        WHERE a.org_id=? AND a.subscription_id=? AND a.customer_id=? AND a.livemode=0 AND a.association_generation=? AND a.association_generation=(SELECT MAX(association_generation) FROM stripe_billing_associations WHERE org_id=?))
        AND NOT EXISTS(SELECT 1 FROM stripe_subscription_checkout_intents WHERE org_id=? AND state IN ('prepared','dispatched','session_known'))
        AND NOT EXISTS(SELECT 1 FROM stripe_billing_customer_commands WHERE org_id=? AND state<>'verified')
        AND NOT EXISTS(SELECT 1 FROM stripe_subscription_cancellation_intents cancellation WHERE org_id=? AND subscription_id=?
          AND NOT EXISTS(SELECT 1 FROM stripe_billing_plan_change_slots slot JOIN stripe_billing_plan_changes c ON c.org_id=slot.org_id AND c.reference=slot.reference
            JOIN stripe_billing_plan_change_steps step ON step.org_id=c.org_id AND step.reference=c.reference
            WHERE slot.org_id=cancellation.org_id AND c.kind='cancel' AND c.subscription_id=cancellation.subscription_id
              AND json_extract(c.frozen_json,'$.custodyRequestKeyDigest')=cancellation.request_key_digest AND step.step='release' AND step.state='verified'))`,
        params: [
          target.terms.organizationId,
          target.terms.subscriptionId,
          target.terms.customerId,
          target.generation,
          target.terms.organizationId,
          target.terms.organizationId,
          target.terms.organizationId,
          target.terms.organizationId,
          target.terms.subscriptionId,
        ],
      };
    },
    async cancel(input) {
      return await custody.cancel(
        input.organizationId,
        input.reference,
        input.expectedSubscriptionRef,
      );
    },
    // A newly attached schedule without the create's command marker is not a
    // qualified origin witness. An unknown creation acknowledgement stays held
    // for explicit processor reconciliation; it is never adopted or re-POSTed.
    async recoverCreatedSchedule() {
      return null;
    },
  };
  plans = createSubscriptionPlanChanges({
    sql,
    client,
    clock,
    custody: extensionCustody,
    realm,
    qualifyPlan: context.qualifyPlan,
  });
  const readyPlans = {
    ...plans,
    async change(input: Parameters<typeof plans.change>[0]) {
      await context.ready();
      return await plans.change(input);
    },
    async pending(organizationId: string) {
      await context.ready();
      return await plans.pending(organizationId);
    },
    async reconcilePending(limit?: number) {
      await context.ready();
      return await plans.reconcilePending(limit);
    },
  };
  return {
    plans: readyPlans,
    verifyPeriodTerms: plans.verifyPeriodTerms,
    resolveCurrentTerms,
    managementGuard,
    async cancel(input) {
      await context.ready();
      qualified();
      if (input.cancelAtPeriodEnd !== true) fail("subscription_management_conflict");
      const existing = (
        await sql.query(
          "SELECT kind,desired_json FROM stripe_billing_plan_changes WHERE org_id=? AND reference=?",
          [input.organizationId, input.reference],
        )
      )[0];
      if (existing) return await plans.cancelPendingChange(input);
      const slot = (
        await sql.query(
          "SELECT c.kind,c.state FROM stripe_billing_plan_change_slots s JOIN stripe_billing_plan_changes c ON c.org_id=s.org_id AND c.reference=s.reference WHERE s.org_id=?",
          [input.organizationId],
        )
      )[0];
      if (slot) {
        if (slot.kind !== "plan-change" || slot.state !== "verified")
          fail("subscription_management_conflict");
        return await plans.cancelPendingChange(input);
      }
      return await custody.cancel(
        input.organizationId,
        input.reference,
        input.expectedSubscriptionRef,
      );
    },
  };
}
