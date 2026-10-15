import { parseBillingConfig } from "./billing-config.ts";
import {
  assertHostedBillingFinancialRealm,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import { type HostedPricing, parsePersistedHostedPricing } from "./hosted-pricing.ts";
import { canonicalJson } from "./json.ts";
import { stripeRefundSource } from "./ledger.ts";
import { MoneyError, minorToMicros } from "./money.ts";
import { OrgTopUpError, type OrgTopUps } from "./org-top-up.ts";
import type { FundingCredit, PaymentEventContext } from "./payment-events.ts";
import { type Clock, type Row, type Sql, SqlError } from "./ports.ts";
import {
  type StripeBillingClient,
  StripeBillingClientError,
  type StripeBillingObject,
} from "./stripe-billing-client.ts";
import {
  assertStripeBillingStoreOrigin,
  type BillingGrant,
  createStripeBillingStore,
  type StripeBillingStore,
  StripeBillingStoreError,
} from "./stripe-billing-store.ts";
import { type createStripeCardSetup, StripeCardSetupError } from "./stripe-card-setup.ts";
import { verifyStripeCustomerBinding } from "./stripe-customer-custody.ts";
import type {
  StripeEventEnvelope,
  StripeEventHandler,
  StripeEventHandling,
} from "./stripe-events.ts";
import { assertStripeModeRealm, type StripeMode } from "./stripe-mode-realm.ts";
import {
  assertStripeOnDemandService,
  StripeOnDemandError,
  type StripeOnDemandService,
} from "./stripe-on-demand.ts";
import type { StripeOnDemandFundingProof } from "./stripe-on-demand-verification.ts";
import {
  type createSubscriptionPlanChanges,
  type QualifiedSubscriptionPlan,
  type SubscriptionPeriodTerms,
  SubscriptionPlanChangeError,
} from "./stripe-subscription-plan-change.ts";
import { assertTopUpSessionCommand, frozenTopUpExpiry } from "./stripe-top-up-client.ts";
import { createSubscriptionCommandReceipts } from "./subscription-command-receipts.ts";
import {
  type Association,
  type CancellationReceipt,
  type CheckoutReceipt,
  createSubscriptionCustody,
  SubscriptionCustodyError,
  type SubscriptionManagementContext,
  type SubscriptionManagementPredicate,
} from "./subscription-custody.ts";

const PURPOSE = "hosted_subscription";
const TYPES = [
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.refund.updated",
] as const;
const STATUSES = new Set([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);
const MAX_REFUND_PAGES = 10;

export class StripeBillingError extends Error {
  constructor(
    readonly code: string,
    readonly status = 503,
  ) {
    super(code);
    this.name = "StripeBillingError";
  }
}
class Quarantine extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
function refuse(reason: string): never {
  throw new Quarantine(reason);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid_object");
  return value as Record<string, unknown>;
}
function identifier(value: unknown, prefix: string): string {
  const id = typeof value === "string" ? value : record(value).id;
  if (typeof id !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9_]{1,240}$`, "u").test(id))
    refuse("invalid_object");
  return id;
}
function minor(value: unknown, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    refuse("invalid_amount");
  return value;
}
function cashMicros(value: number): number {
  try {
    return minorToMicros(value);
  } catch (error) {
    if (error instanceof MoneyError) refuse("invalid_amount");
    throw error;
  }
}
function timestamp(value: unknown): string {
  const seconds = minor(value, true);
  if (seconds > 253402300799) refuse("invalid_period");
  return new Date(seconds * 1000).toISOString();
}
function metadata(value: unknown): Record<string, unknown> {
  return record(value);
}
function hasHostedClaim(value: unknown): boolean {
  if (value == null) return false;
  const meta = metadata(value);
  return ["takoserverPurpose", "organizationId", "planKey", "pricingRevision"].some(
    (key) => key in meta,
  );
}
function assertInvoiceClaim(invoice: StripeBillingObject, pinned: Record<string, unknown>): void {
  if (invoice.metadata == null) return;
  const claim = metadata(invoice.metadata);
  for (const key of ["takoserverPurpose", "organizationId", "planKey", "pricingRevision"]) {
    if (key in claim && claim[key] !== pinned[key]) refuse("wrong_invoice_claim");
  }
}

function usd(object: Record<string, unknown>): void {
  if (object.currency !== "usd") refuse("wrong_currency");
}
function noConnect(object: Record<string, unknown>): void {
  if (
    object.on_behalf_of != null ||
    object.transfer_data != null ||
    object.application != null ||
    object.account != null
  )
    refuse("wrong_account");
}

export interface SubscriptionPayments {
  readonly planTable: HostedPricing["hostedPlanTable"];
  read(organizationId: string): Promise<Record<string, unknown> | null>;
  begin(input: {
    organizationId: string;
    reference: string;
    planKey: string;
  }): Promise<CheckoutReceipt>;
  change(input: {
    organizationId: string;
    reference: string;
    cancelAtPeriodEnd: boolean;
    expectedSubscriptionRef: string;
  }): Promise<CancellationReceipt>;
}
export interface StripeBillingSubscriptionExtensionContext {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly client: StripeBillingClient;
  readonly custody: ReturnType<typeof createSubscriptionCustody>;
  readonly realm: HostedBillingFinancialRealm;
  ready(): Promise<void>;
  boundCustomer(organizationId: string, customerId: string): Promise<void>;
  qualifyPlan(planKey: string): Promise<QualifiedSubscriptionPlan>;
  planForRevision(planKey: string, pricingRevision: string): Promise<QualifiedSubscriptionPlan>;
}
export interface StripeBillingSubscriptionExtensions {
  readonly plans: ReturnType<typeof createSubscriptionPlanChanges>;
  readonly verifyPeriodTerms: ReturnType<typeof createSubscriptionPlanChanges>["verifyPeriodTerms"];
  resolveCurrentTerms(input: {
    readonly association: Association;
    readonly subscription: StripeBillingObject;
    readonly periodStart: string;
    readonly periodEnd: string;
  }): Promise<SubscriptionPeriodTerms>;
  managementGuard(input: SubscriptionManagementContext): SubscriptionManagementPredicate;
  cancel(input: Parameters<SubscriptionPayments["change"]>[0]): Promise<CancellationReceipt>;
}
const extensionOrigins = new WeakMap<
  StripeBillingSubscriptionExtensionContext,
  {
    readonly sql: Sql;
    readonly clock: Clock;
    readonly client: StripeBillingClient;
    readonly custody: ReturnType<typeof createSubscriptionCustody>;
    readonly realm: HostedBillingFinancialRealm;
  }
>();
/** Only the existing writer constructs custody and its SQL/client-bound extension context. */
export function assertStripeBillingSubscriptionExtensionContext(
  context: StripeBillingSubscriptionExtensionContext,
): void {
  const origin = extensionOrigins.get(context);
  if (
    !origin ||
    origin.sql !== context.sql ||
    origin.clock !== context.clock ||
    origin.client !== context.client ||
    origin.custody !== context.custody ||
    origin.realm !== context.realm
  )
    throw new StripeBillingError("subscription_extension_unqualified");
  assertHostedBillingFinancialRealm(context.realm, {
    sql: context.sql,
    client: context.client,
    billingAuthority: context.realm.billingAuthority,
  });
}
export interface BillingReconcileReport {
  readonly examined: number;
  readonly applied: number;
  readonly unresolved: number;
  readonly truncated: boolean;
  readonly handlerVersion: 1;
}

type PaidPlan = Extract<
  HostedPricing["hostedPlanTable"]["plans"][number],
  { readonly tier: "subscription" }
>;

function paidPlan(table: HostedPricing, planKey: unknown): PaidPlan | undefined {
  return table.hostedPlanTable.plans.find(
    (plan): plan is PaidPlan => plan.tier === "subscription" && plan.planId === planKey,
  );
}

/** Explicitly opted-in hosted billing in the deployment's pinned Stripe realm. */
export function createStripeBilling(options: {
  readonly client: StripeBillingClient;
  readonly context: PaymentEventContext;
  readonly pricing: HostedPricing;
  readonly mode?: StripeMode;
  readonly consoleOrigin?: string | undefined;
  readonly realm?: HostedBillingFinancialRealm;
  readonly ensureCustomer?: (organizationId: string) => Promise<string>;
  readonly topUpCommandForSession?: OrgTopUps["commandForSession"];
  /** Genuine common owner shared with the canonical on-demand service. */
  readonly store?: StripeBillingStore;
  readonly onDemand?: StripeOnDemandService;
  readonly cardSetup?: ReturnType<typeof createStripeCardSetup>;
  readonly subscriptionExtensions?: (
    context: StripeBillingSubscriptionExtensionContext,
  ) => StripeBillingSubscriptionExtensions;
}) {
  const { client, context, pricing } = options;
  const livemode = (options.mode ?? "test") === "live";
  const { sql, clock } = context;
  const store = options.store ?? createStripeBillingStore({ sql, clock });
  assertStripeBillingStoreOrigin(store, { sql, clock });
  const parsedBilling = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
  if (!parsedBilling) throw new StripeBillingError("billing_configuration_invalid");
  const billing = parsedBilling;
  const onDemand = options.onDemand;
  const cardSetup = options.cardSetup;
  if (onDemand) {
    if (!options.realm) throw new StripeBillingError("financial_realm_unqualified");
    assertStripeOnDemandService(onDemand, {
      sql,
      clock,
      client,
      realm: options.realm,
      store,
      billingConfig: billing,
    });
  }
  if (cardSetup && !onDemand) throw new StripeBillingError("financial_realm_unqualified");
  const eventTypes = [
    ...TYPES,
    ...(onDemand ? ["payment_intent.succeeded", "payment_intent.canceled"] : []),
    ...(cardSetup ? ["checkout.session.expired"] : []),
  ];
  const now = () => clock().toISOString();
  if ((options.subscriptionExtensions || options.topUpCommandForSession) && !options.realm)
    throw new StripeBillingError("financial_realm_unqualified");
  if (options.realm) {
    if (livemode) throw new StripeBillingError("financial_realm_unqualified");
    assertHostedBillingFinancialRealm(options.realm, {
      sql,
      client,
      billingAuthority: options.realm.billingAuthority,
      prices: pricing.hostedPlanTable.plans
        .filter((plan): plan is PaidPlan => plan.tier === "subscription")
        .map((plan) => ({
          priceId: plan.stripePriceId,
          monthlyAmountMinor: plan.monthlyAmountMinor,
        })),
    });
  }
  let initialization: Promise<void> | undefined;
  const ready = async () => {
    if (initialization === undefined) initialization = initialize();
    const pending = initialization;
    try {
      await pending;
    } catch (error) {
      if (initialization === pending) initialization = undefined;
      throw error;
    }
  };

  async function initialize(): Promise<void> {
    await assertStripeModeRealm(sql, options.mode ?? "test");
    await assertStripeBillingSchema(sql);
    const json = canonicalJson(pricing);
    const snapshots = await sql.query("SELECT revision, config_json FROM stripe_billing_pricing");
    const statements: { sql: string; params: readonly (string | number | null)[] }[] = [];
    const register = (
      snapshot: HostedPricing,
      revision: string,
      snapshotJson: string,
      candidate: boolean,
    ) => {
      for (const plan of snapshot.hostedPlanTable.plans) {
        if (plan.tier !== "subscription") continue;
        statements.push({
          sql: `INSERT OR IGNORE INTO stripe_billing_price_identity
          (livemode,price_id,plan_key,amount_minor,included_minor,period_months) VALUES (?,?,?,?,?,1)`,
          params: [
            Number(livemode),
            plan.stripePriceId,
            plan.planId,
            plan.monthlyAmountMinor,
            plan.includedCreditMinor,
          ],
        });
      }
      if (candidate)
        statements.push({
          sql: "INSERT OR IGNORE INTO stripe_billing_pricing (revision, config_json) VALUES (?, ?)",
          params: [revision, snapshotJson],
        });
      for (const plan of snapshot.hostedPlanTable.plans) {
        if (plan.tier !== "subscription") continue;
        statements.push({
          sql: `INSERT INTO stripe_billing_price_identity_checks (id,valid) VALUES (?, CASE WHEN
          EXISTS (SELECT 1 FROM stripe_billing_price_identity WHERE livemode = ? AND price_id = ?
            AND plan_key = ? AND amount_minor = ? AND included_minor = ? AND period_months = 1)
          AND EXISTS (SELECT 1 FROM stripe_billing_pricing WHERE revision = ? AND config_json = ?)
          THEN 1 ELSE 0 END)
          ON CONFLICT(id) DO UPDATE SET valid = excluded.valid`,
          params: [
            `pricing:${revision}:${plan.planId}`,
            Number(livemode),
            plan.stripePriceId,
            plan.planId,
            plan.monthlyAmountMinor,
            plan.includedCreditMinor,
            revision,
            snapshotJson,
          ],
        });
      }
    };
    for (const row of snapshots) {
      const snapshot = JSON.parse(String(row.config_json)) as HostedPricing;
      const parsed = parsePersistedHostedPricing(
        snapshot.environment.TAKOSERVER_HOSTED_PRICING,
        String(row.revision),
      );
      if (!parsed || canonicalJson(parsed) !== canonicalJson(snapshot))
        throw new StripeBillingError("pricing_revision_conflict");
      const historicalRevision = String(
        parseBillingConfig(parsed.environment.TAKOSERVER_BILLING_CONFIG)?.revision ?? "",
      );
      if (!historicalRevision) throw new StripeBillingError("pricing_revision_conflict");
      register(parsed, historicalRevision, String(row.config_json), false);
    }
    register(pricing, billing.revision, json, true);
    try {
      await sql.batch(statements);
    } catch (error) {
      if (error instanceof SqlError && error.code === "constraint")
        throw new StripeBillingError("price_identity_conflict", 409);
      throw error;
    }
  }
  async function tariff(revision: unknown): Promise<HostedPricing> {
    if (typeof revision !== "string") refuse("pricing_revision_unavailable");
    const rows = await sql.query(
      "SELECT config_json FROM stripe_billing_pricing WHERE revision = ?",
      [revision],
    );
    if (!rows[0]) refuse("pricing_revision_unavailable");
    const snapshot = JSON.parse(String(rows[0].config_json)) as HostedPricing;
    const parsed = parsePersistedHostedPricing(
      snapshot.environment.TAKOSERVER_HOSTED_PRICING,
      revision,
    );
    if (!parsed || canonicalJson(parsed) !== canonicalJson(snapshot))
      refuse("pricing_revision_conflict");
    return parsed;
  }
  async function exists(org: unknown): Promise<string> {
    if (
      typeof org !== "string" ||
      org.length < 1 ||
      org.length > 128 ||
      !(await sql.query("SELECT 1 FROM orgs WHERE id = ?", [org])).length
    )
      refuse("unknown_organization");
    return org;
  }
  async function boundCustomer(org: string, customer: string): Promise<void> {
    if (options.realm) {
      try {
        await verifyStripeCustomerBinding({ sql, client, realm: options.realm }, org, customer);
      } catch (error) {
        if (error instanceof OrgTopUpError)
          throw new SubscriptionPlanChangeError("customer_binding_unresolved", 503);
        throw error;
      }
      return;
    }
    const rows = await sql.query(
      "SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?",
      [org],
    );
    if (rows[0]?.customer_id !== customer) refuse("wrong_customer");
    const object = await client.get("customers", customer);
    if (!object) refuse("wrong_customer");
    const meta = object.metadata == null ? null : metadata(object.metadata);
    if (meta?.organizationId != null && meta.organizationId !== org) refuse("wrong_customer");
    if (meta?.takoserverPurpose != null && meta.takoserverPurpose !== PURPOSE)
      refuse("wrong_customer");
    noConnect(object);
  }
  async function isBoundHostedCustomer(value: unknown): Promise<boolean> {
    const customer = identifier(value, "cus");
    return (
      (
        await sql.query("SELECT 1 FROM stripe_billing_customers WHERE customer_id = ? LIMIT 1", [
          customer,
        ])
      ).length > 0
    );
  }
  async function price(id: string, table: HostedPricing, requireActive = false): Promise<void> {
    const plan = table.hostedPlanTable.plans.find(
      (candidate): candidate is PaidPlan =>
        candidate.tier === "subscription" && candidate.stripePriceId === id,
    );
    if (!plan) refuse("wrong_price");
    const object = await client.get("prices", plan.stripePriceId);
    if (!object) refuse("unknown_price");
    noConnect(object);
    const recurring = record(object.recurring);
    usd(object);
    if (
      object.object !== "price" ||
      object.livemode !== livemode ||
      (requireActive && object.active !== true) ||
      object.type !== "recurring" ||
      object.billing_scheme !== "per_unit" ||
      object.transform_quantity != null ||
      object.custom_unit_amount != null ||
      object.tiers != null ||
      object.tiers_mode != null ||
      object.unit_amount !== plan.monthlyAmountMinor ||
      (object.unit_amount_decimal !== undefined &&
        object.unit_amount_decimal !== String(plan.monthlyAmountMinor)) ||
      recurring.interval !== "month" ||
      recurring.interval_count !== 1 ||
      recurring.usage_type !== "licensed"
    )
      refuse("unsupported_plan");
  }
  const paidPlans = pricing.hostedPlanTable.plans.filter(
    (plan): plan is PaidPlan => plan.tier === "subscription",
  );
  let extensions: StripeBillingSubscriptionExtensions | undefined;
  const custody = createSubscriptionCustody({
    sql,
    client,
    clock,
    consoleOrigin: options.consoleOrigin ?? "",
    plans: paidPlans,
    pricingRevision: billing.revision,
    effectiveAt: billing.effectiveAt,
    validatePrice: async (id, revision, requireActive) =>
      await price(
        id,
        revision === billing.revision ? pricing : await tariff(revision),
        requireActive,
      ),
    validateCustomer: boundCustomer,
    isConclusivePreflightFailure: (error) =>
      error instanceof Quarantine &&
      [
        "wrong_price",
        "unknown_price",
        "unsupported_plan",
        "wrong_currency",
        "wrong_account",
        "wrong_customer",
        "invalid_object",
      ].includes(error.reason),
    mode: options.mode ?? "test",
    requireBoundCustomer: options.realm !== undefined,
    ...(options.ensureCustomer ? { ensureCustomer: options.ensureCustomer } : {}),
    ...(options.subscriptionExtensions
      ? {
          managementGuard: (input: SubscriptionManagementContext) => {
            if (!extensions) throw new StripeBillingError("subscription_extension_unqualified");
            return extensions.managementGuard(input);
          },
          resolveCurrentTerms: async (input: {
            readonly association: Association;
            readonly subscription: StripeBillingObject;
            readonly periodStart: string;
            readonly periodEnd: string;
          }) => {
            if (!extensions) throw new StripeBillingError("subscription_extension_unqualified");
            return await extensions.resolveCurrentTerms(input);
          },
        }
      : {}),
  });
  if (options.subscriptionExtensions && options.realm) {
    async function planForRevision(
      planKey: string,
      revision: string,
    ): Promise<QualifiedSubscriptionPlan> {
      await ready();
      const snapshot = revision === billing.revision ? pricing : await tariff(revision);
      const plan = paidPlan(snapshot, planKey);
      if (!plan) throw new StripeBillingError("pricing_revision_unavailable");
      await price(plan.stripePriceId, snapshot);
      return {
        planKey: plan.planId,
        pricingRevision: revision,
        priceId: plan.stripePriceId,
        priceAmountMinor: plan.monthlyAmountMinor,
        includedMinor: plan.includedCreditMinor,
      };
    }
    const extensionContext: StripeBillingSubscriptionExtensionContext = Object.freeze({
      sql,
      clock,
      client,
      custody,
      realm: options.realm,
      ready,
      boundCustomer,
      planForRevision,
      async qualifyPlan(planKey: string) {
        if (billing.effectiveAt > now()) throw new StripeBillingError("pricing_not_effective", 409);
        const plan = await planForRevision(planKey, billing.revision);
        await price(plan.priceId, pricing, true);
        return plan;
      },
    });
    extensionOrigins.set(extensionContext, { sql, clock, client, custody, realm: options.realm });
    extensions = options.subscriptionExtensions(extensionContext);
  }
  async function historicalAssociation(
    subscriptionId: string,
    org: string,
    customer: string,
    planKey: string,
    revision: string,
    priceId: string,
    priceAmountMinor: number,
    includedMinor: number,
    periodStart: string,
    periodEnd: string,
  ): Promise<void> {
    const bound = await custody.association(subscriptionId);
    if (
      !bound ||
      bound.organizationId !== org ||
      bound.customerId !== customer ||
      bound.livemode !== livemode
    )
      refuse("unbound_subscription");
    if (extensions) {
      await extensions.verifyPeriodTerms({
        terms: {
          organizationId: org,
          subscriptionId,
          customerId: customer,
          planKey,
          pricingRevision: revision,
          priceId,
          priceAmountMinor,
          includedMinor,
        },
        periodStart,
        periodEnd,
      });
    } else if (
      bound.planKey !== planKey ||
      bound.pricingRevision !== revision ||
      bound.priceId !== priceId ||
      bound.priceAmountMinor !== priceAmountMinor ||
      bound.includedMinor !== includedMinor
    )
      refuse("unbound_subscription");
  }
  async function subscriptionFacts(object: StripeBillingObject, table?: HostedPricing) {
    noConnect(object);
    const meta = metadata(object.metadata);
    if (meta.takoserverPurpose !== PURPOSE) refuse("not_hosted_subscription");
    const org = await exists(meta.organizationId);
    const customer = identifier(object.customer, "cus");
    await boundCustomer(org, customer);
    const snapshot = table ?? (await tariff(meta.pricingRevision));
    const plan = paidPlan(snapshot, meta.planKey);
    if (!plan) refuse("wrong_plan");
    const items = record(object.items);
    if (items.has_more !== false || !Array.isArray(items.data) || items.data.length !== 1)
      refuse("unsupported_subscription_items");
    const item = record(items.data[0]);
    if (item.quantity !== 1 || identifier(item.price, "price") !== plan.stripePriceId)
      refuse("wrong_price");
    await price(plan.stripePriceId, snapshot);
    if (
      typeof object.status !== "string" ||
      !STATUSES.has(object.status) ||
      typeof object.cancel_at_period_end !== "boolean"
    )
      refuse("invalid_subscription");
    const periodStart = timestamp(object.current_period_start);
    const periodEnd = timestamp(object.current_period_end);
    if (periodEnd <= periodStart) refuse("invalid_period");
    await historicalAssociation(
      identifier(object.id, "sub"),
      org,
      customer,
      plan.planId,
      String(meta.pricingRevision),
      plan.stripePriceId,
      plan.monthlyAmountMinor,
      plan.includedCreditMinor,
      periodStart,
      periodEnd,
    );
    return { org, customer, snapshot, plan, periodStart, periodEnd };
  }
  async function updateSubscription(id: string): Promise<StripeEventHandling> {
    const claim = await sql.run(
      "INSERT INTO stripe_billing_object_claims (object_id, generation) VALUES (?, 1) ON CONFLICT(object_id) DO UPDATE SET generation = generation + 1 RETURNING generation",
      [id],
    );
    const generation = Number(claim.rows[0]?.generation);
    const object = await client.get("subscriptions", id);
    if (!object) refuse("unknown_subscription");
    noConnect(object);
    const known = await sql.query(
      `SELECT 1 FROM stripe_billing_associations WHERE subscription_id = ?
       UNION SELECT 1 FROM stripe_billing_subscriptions WHERE subscription_id = ?
       UNION SELECT 1 FROM stripe_billing_grants WHERE subscription_id = ? LIMIT 1`,
      [id, id, id],
    );
    if (
      !known.length &&
      !hasHostedClaim(object.metadata) &&
      !(await isBoundHostedCustomer(object.customer))
    )
      return { outcome: "ignored", detail: "not_hosted_subscription" };
    const facts = await subscriptionFacts(object);
    const paid = await sql.query(
      "SELECT MAX(period_end) AS paid_through FROM stripe_billing_grants g WHERE org_id = ? AND subscription_id = ? AND source_type = 'invoice' AND NOT EXISTS (SELECT 1 FROM stripe_billing_refunds r WHERE r.org_id = g.org_id AND r.funding_ref = g.funding_ref AND r.cumulative_refunded_micros >= g.consideration_micros)",
      [facts.org, id],
    );
    await sql.run(
      `INSERT INTO stripe_billing_subscriptions
      (org_id, subscription_id, customer_id, plan_key, pricing_revision, status, cancel_at_period_end, period_start, period_end, paid_through, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM stripe_billing_object_claims WHERE object_id = ? AND generation = ?)
        AND EXISTS (SELECT 1 FROM stripe_billing_associations candidate WHERE candidate.subscription_id = ?
          AND candidate.association_generation = (SELECT MAX(association_generation) FROM stripe_billing_associations WHERE org_id = ?))
      ON CONFLICT(org_id) DO UPDATE SET subscription_id = excluded.subscription_id, customer_id = excluded.customer_id,
        plan_key = excluded.plan_key, pricing_revision = excluded.pricing_revision, status = excluded.status,
        cancel_at_period_end = excluded.cancel_at_period_end, period_start = excluded.period_start,
        period_end = excluded.period_end, paid_through = excluded.paid_through, updated_at = excluded.updated_at
      WHERE stripe_billing_subscriptions.subscription_id = excluded.subscription_id OR
        (stripe_billing_subscriptions.status IN ('canceled','incomplete_expired')
          AND (SELECT association_generation FROM stripe_billing_associations WHERE subscription_id = stripe_billing_subscriptions.subscription_id)
            < (SELECT association_generation FROM stripe_billing_associations WHERE subscription_id = excluded.subscription_id))`,
      [
        facts.org,
        id,
        facts.customer,
        facts.plan.planId,
        metadata(object.metadata).pricingRevision as string,
        object.status as string,
        object.cancel_at_period_end ? 1 : 0,
        facts.periodStart,
        facts.periodEnd,
        paid[0]?.paid_through == null ? null : String(paid[0].paid_through),
        now(),
        id,
        generation,
        id,
        facts.org,
      ],
    );
    const current = (
      await sql.query("SELECT subscription_id FROM stripe_billing_subscriptions WHERE org_id = ?", [
        facts.org,
      ])
    )[0];
    if (current?.subscription_id !== id) {
      const generations = await sql.query(
        `SELECT (SELECT association_generation FROM stripe_billing_associations WHERE subscription_id = ?) AS observed,
                (SELECT association_generation FROM stripe_billing_associations WHERE subscription_id = ?) AS projected`,
        [id, String(current?.subscription_id ?? "")],
      );
      if (Number(generations[0]?.observed) < Number(generations[0]?.projected))
        return { outcome: "applied", detail: "older_subscription_ignored" };
      refuse("multiple_subscriptions");
    }
    return { outcome: "applied", detail: "subscription_updated" };
  }

  async function unrelatedInvoice(invoice: StripeBillingObject): Promise<boolean> {
    noConnect(invoice);
    if (await store.grantForSource("invoice", invoice.id)) return false;
    if (hasHostedClaim(invoice.metadata)) return false;
    const details =
      invoice.subscription_details == null ? null : record(invoice.subscription_details);
    if (hasHostedClaim(details?.metadata)) return false;
    if (invoice.subscription == null) {
      if (invoice.customer != null && (await isBoundHostedCustomer(invoice.customer))) return false;
      return !["subscription_create", "subscription_cycle"].includes(
        String(invoice.billing_reason),
      );
    }
    const subscriptionId = identifier(invoice.subscription, "sub");
    const known = await sql.query(
      `SELECT 1 FROM stripe_billing_associations WHERE subscription_id = ?
       UNION SELECT 1 FROM stripe_billing_subscriptions WHERE subscription_id = ?
       UNION SELECT 1 FROM stripe_billing_grants WHERE subscription_id = ? LIMIT 1`,
      [subscriptionId, subscriptionId, subscriptionId],
    );
    if (known.length) return false;
    const subscription = await client.get("subscriptions", subscriptionId);
    if (!subscription) refuse("unknown_subscription");
    noConnect(subscription);
    if (identifier(subscription.customer, "cus") !== identifier(invoice.customer, "cus"))
      refuse("wrong_customer");
    return (
      !hasHostedClaim(subscription.metadata) && !(await isBoundHostedCustomer(invoice.customer))
    );
  }

  async function invoiceGrant(id: string): Promise<BillingGrant> {
    const invoice = await client.get("invoices", id);
    if (!invoice) refuse("unknown_invoice");
    noConnect(invoice);
    usd(invoice);
    if (
      invoice.status !== "paid" ||
      invoice.paid !== true ||
      invoice.paid_out_of_band !== false ||
      invoice.amount_remaining !== 0
    )
      refuse("invoice_not_paid");
    if (!["subscription_create", "subscription_cycle"].includes(String(invoice.billing_reason)))
      refuse("unsupported_invoice_reason");
    const subscriptionId = identifier(invoice.subscription, "sub");
    const sub = await client.get("subscriptions", subscriptionId);
    if (!sub) refuse("unknown_subscription");
    const pinned = metadata(record(invoice.subscription_details).metadata);
    if (pinned.takoserverPurpose !== PURPOSE) refuse("not_hosted_subscription");
    assertInvoiceClaim(invoice, pinned);
    const snapshot = await tariff(pinned.pricingRevision);
    const plan = paidPlan(snapshot, pinned.planKey);
    if (!plan || metadata(sub.metadata).organizationId !== pinned.organizationId)
      refuse("wrong_plan");
    const org = await exists(pinned.organizationId);
    const customer = identifier(invoice.customer, "cus");
    if (identifier(sub.customer, "cus") !== customer) refuse("wrong_customer");
    await boundCustomer(org, customer);
    // The invoice's historical association, not today's one-row projection,
    // owns its Organization and terms. A delayed old invoice cannot inherit a
    // newer current subscription or its current Price.
    const lines = record(invoice.lines);
    if (lines.has_more !== false || !Array.isArray(lines.data) || lines.data.length !== 1)
      refuse("unsupported_invoice_lines");
    const line = record(lines.data[0]);
    if (
      line.type !== "subscription" ||
      line.proration !== false ||
      line.quantity !== 1 ||
      identifier(line.subscription, "sub") !== subscriptionId ||
      identifier(line.price, "price") !== plan.stripePriceId
    )
      refuse("unsupported_invoice_line");
    await price(plan.stripePriceId, snapshot);
    const period = record(line.period);
    const periodStart = timestamp(period.start),
      periodEnd = timestamp(period.end);
    if (periodEnd <= periodStart) refuse("invalid_period");
    await historicalAssociation(
      subscriptionId,
      org,
      customer,
      plan.planId,
      String(pinned.pricingRevision),
      plan.stripePriceId,
      plan.monthlyAmountMinor,
      plan.includedCreditMinor,
      periodStart,
      periodEnd,
    );
    const consideration = minor(invoice.amount_paid, true);
    if (
      consideration !== plan.monthlyAmountMinor ||
      invoice.total !== consideration ||
      invoice.total_excluding_tax !== consideration ||
      minor(invoice.amount_shipping ?? 0) !== 0 ||
      minor(invoice.starting_balance ?? 0) !== 0 ||
      minor(invoice.ending_balance ?? 0) !== 0 ||
      minor(invoice.post_payment_credit_notes_amount ?? 0) !== 0 ||
      minor(invoice.pre_payment_credit_notes_amount ?? 0) !== 0
    )
      refuse("ambiguous_service_consideration");
    const chargeId = identifier(invoice.charge, "ch");
    const charge = await client.get("charges", chargeId);
    if (!charge) refuse("unknown_charge");
    validateCharge(charge, consideration);
    if (identifier(charge.invoice, "in") !== id || identifier(charge.customer, "cus") !== customer)
      refuse("wrong_charge");
    // Payment proves cash collection, not that this service period has begun.
    // Keep the verified original invoice deferred so reconciliation can grant
    // its frozen period exactly once when its start is reached.
    if (periodStart > now()) refuse("invoice_period_not_started");
    return {
      organizationId: org,
      fundingRef: `stripe:invoice:${id}`,
      kind: "plan-included",
      amountMicros: cashMicros(plan.includedCreditMinor),
      expiresAt: periodEnd,
      sourceType: "invoice",
      sourceId: id,
      chargeId,
      customerId: customer,
      subscriptionId,
      planKey: plan.planId,
      pricingRevision: pinned.pricingRevision as string,
      stripePriceId: plan.stripePriceId,
      periodStart,
      periodEnd,
      considerationMicros: cashMicros(consideration),
    };
  }
  function validateCharge(charge: StripeBillingObject, amount: number): void {
    noConnect(charge);
    usd(charge);
    if (
      charge.paid !== true ||
      charge.status !== "succeeded" ||
      charge.captured !== true ||
      charge.disputed !== false ||
      minor(charge.amount, true) !== amount
    )
      refuse("unverifiable_charge");
  }

  async function freezePriorWalletFunding(sessionId: string): Promise<boolean> {
    const fundingRef = `stripe:${sessionId}`;
    const rows = await sql.query(
      "SELECT org_id FROM wallet_credit_lots WHERE ref = ? AND consumption_class = 'purchased'",
      [fundingRef],
    );
    for (const row of rows) await store.freezeFunding(String(row.org_id), fundingRef);
    return rows.length > 0;
  }

  async function checkoutGrant(id: string): Promise<BillingGrant> {
    const session = await client.get("checkout/sessions", id, {
      expand: ["payment_intent.latest_charge"],
    });
    if (!session) refuse("unknown_session");
    usd(session);
    noConnect(session);
    const meta = session.metadata == null ? null : metadata(session.metadata);
    if (session.mode !== "payment" || meta?.takoserverPurpose !== "wallet_funding") {
      if (await freezePriorWalletFunding(id)) refuse("wallet_funding_proof_missing");
      refuse(meta && hasHostedClaim(meta) ? "invalid_wallet_funding" : "not_wallet_funding");
    }
    if (session.payment_status !== "paid" || session.status !== "complete") refuse("not_paid");
    const org = await exists(meta.organizationId);
    const amount = minor(session.amount_total, true);
    const prior = await store.grantForSource("checkout", id);
    const command = options.topUpCommandForSession
      ? await options.topUpCommandForSession(id)
      : null;
    const commandClaim = [
      "topUpReference",
      "topUpCommandDigest",
      "stripeAccountId",
      "financialRealm",
      "purchaseCreditExpiry",
    ].some((key) => key in meta);
    if ((options.realm && !prior) || command || commandClaim) {
      if (!command || !options.realm) refuse("top_up_custody_required");
      await assertTopUpSessionCommand({ sql, client, realm: options.realm }, session, command);
      if (
        command.organizationId !== org ||
        command.amountMinor !== amount ||
        (prior &&
          (prior.pricingRevision !== command.pricingRevision ||
            prior.amountMicros !== command.amountMicros ||
            prior.customerId !== command.customerId))
      )
        refuse("top_up_command_conflict");
    }
    const intent = record(session.payment_intent);
    if (intent.status !== "succeeded") refuse("unverifiable_payment");
    const chargeId = identifier(intent.latest_charge, "ch");
    const charge = await client.get("charges", chargeId);
    if (!charge) refuse("unknown_charge");
    validateCharge(charge, amount);
    if (identifier(charge.payment_intent, "pi") !== identifier(intent.id, "pi"))
      refuse("wrong_charge");
    const customer = session.customer == null ? null : identifier(session.customer, "cus");
    if ((charge.customer == null ? null : identifier(charge.customer, "cus")) !== customer)
      refuse("wrong_customer");
    const legacy = (
      await sql.query(
        "SELECT kind, expires_at FROM wallet_credit_lots WHERE org_id = ? AND ref = ?",
        [org, `stripe:${id}`],
      )
    )[0];
    const createdAt = timestamp(session.created);
    // First settlement can arrive after a tariff rotation. Resolve the
    // immutable revision at Checkout creation, then persist it with the lot.
    const snapshot = [billing, ...(billing.history ?? [])]
      .filter((candidate) => candidate.effectiveAt <= createdAt)
      .sort((left, right) => right.effectiveAt.localeCompare(left.effectiveAt))[0];
    if (!command && !prior && !legacy && !snapshot) refuse("pricing_history_missing");
    const expiry = snapshot?.purchaseCreditExpiry;
    const expiresAt = prior
      ? prior.expiresAt
      : legacy?.kind === "direct"
        ? legacy.expires_at == null
          ? null
          : String(legacy.expires_at)
        : command
          ? frozenTopUpExpiry(command, now())
          : expiry?.kind === "fixed-duration"
            ? new Date(Date.parse(now()) + expiry.seconds * 1000).toISOString()
            : null;
    return {
      organizationId: org,
      fundingRef: `stripe:${id}`,
      kind: "purchased",
      amountMicros: command ? command.amountMicros : cashMicros(amount),
      expiresAt,
      sourceType: "checkout",
      sourceId: id,
      chargeId,
      customerId: customer,
      subscriptionId: null,
      planKey: null,
      pricingRevision: prior
        ? prior.pricingRevision
        : command
          ? command.pricingRevision
          : legacy
            ? null
            : (snapshot?.revision ?? null),
      stripePriceId: null,
      periodStart: null,
      periodEnd: null,
      considerationMicros: cashMicros(amount),
    };
  }

  async function settleGrant(grant: BillingGrant): Promise<void> {
    const charge = await client.get("charges", grant.chargeId);
    if (!charge) refuse("unknown_charge");
    if (options.realm && grant.customerId)
      await boundCustomer(grant.organizationId, grant.customerId);
    if (minor(charge.amount_refunded) > 0) await refundCharge(grant.chargeId, grant);
    else await store.grant(grant);
  }
  async function refunds(chargeId: string) {
    const result: StripeBillingObject[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_REFUND_PAGES; page++) {
      const list = await client.list("refunds", {
        charge: chargeId,
        ...(cursor ? { startingAfter: cursor } : {}),
        limit: 100,
      });
      for (const item of list.data) {
        const actual = await client.get("refunds", item.id);
        if (!actual || identifier(actual.charge, "ch") !== chargeId) refuse("wrong_refund_charge");
        usd(actual);
        if (
          !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(
            String(actual.status),
          )
        )
          refuse("invalid_refund_status");
        await sql.run(
          "INSERT INTO stripe_billing_refund_observations (refund_id, charge_id, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(refund_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at WHERE charge_id = excluded.charge_id",
          [actual.id, chargeId, actual.status as string, now()],
        );
        result.push(actual);
      }
      if (!list.hasMore) return result;
      cursor = list.data.at(-1)?.id;
      if (!cursor) refuse("refund_scan_truncated");
    }
    refuse("refund_scan_truncated");
  }
  async function refundCharge(
    chargeId: string,
    knownGrant?: BillingGrant,
  ): Promise<StripeEventHandling> {
    const existing = await store.grantsForCharge(chargeId);
    if (existing.length > 1) {
      for (const original of existing)
        await store.freezeFunding(original.organizationId, original.fundingRef);
      refuse("ambiguous_refund_allocation");
    }
    let grant = existing[0] ?? knownGrant;
    let fenceGeneration = grant
      ? await store.freezeFunding(grant.organizationId, grant.fundingRef)
      : undefined;
    const charge = await client.get("charges", chargeId);
    if (!charge) refuse("unknown_charge");
    noConnect(charge);
    usd(charge);
    if (grant?.sourceType === "payment-intent" && !onDemand)
      refuse("on_demand_original_unresolved");
    let native: StripeOnDemandFundingProof | null = null;
    if (
      onDemand &&
      (!grant || grant.sourceType === "payment-intent") &&
      charge.payment_intent != null
    ) {
      native = await onDemand.readFundingProofForPaymentIntent(
        identifier(charge.payment_intent, "pi"),
      );
      if (native) {
        if (native.chargeId !== chargeId) refuse("ambiguous_refund_allocation");
        // A refund observed before first funding cannot expose gross purchased
        // credit. The same common owner grants under this durable source fence.
        fenceGeneration ??= await store.freezeFunding(native.organizationId, native.fundingRef);
        grant = await store.grantOnDemand({
          organizationId: native.organizationId,
          reference: native.reference,
          expectedCommandFingerprint: native.fingerprint,
          native,
        });
      } else if (grant?.sourceType === "payment-intent") refuse("on_demand_original_unresolved");
    }
    if (!grant) {
      if (hasHostedClaim(charge.metadata)) refuse("ambiguous_refund_allocation");
      let unrelated = charge.invoice == null;
      if (charge.invoice != null) {
        const invoiceId = identifier(charge.invoice, "in");
        const invoice = await client.get("invoices", invoiceId);
        if (!invoice) refuse("unknown_invoice");
        unrelated = await unrelatedInvoice(invoice);
        if (!unrelated) grant = await invoiceGrant(invoiceId);
      }
      if (!grant) {
        const sessions = await client.list("checkout/sessions", {
          paymentIntent: identifier(charge.payment_intent, "pi"),
          limit: 100,
        });
        if (sessions.hasMore || sessions.data.length > 1) refuse("ambiguous_refund_allocation");
        if (!sessions.data.length) {
          if (
            !unrelated ||
            (charge.customer != null && (await isBoundHostedCustomer(charge.customer)))
          )
            refuse("ambiguous_refund_allocation");
          return { outcome: "ignored", detail: "not_hosted_funding" };
        }
        grant = await checkoutGrant(sessions.data[0]?.id ?? "");
      }
    }
    if (
      grant.chargeId !== chargeId ||
      grant.considerationMicros !== cashMicros(minor(charge.amount, true))
    )
      refuse("ambiguous_refund_allocation");
    fenceGeneration ??= await store.freezeFunding(grant.organizationId, grant.fundingRef);
    const all = await refunds(chargeId);
    const pending = all.some(
      (item) => item.status === "pending" || item.status === "requires_action",
    );
    let successful = all
      .filter((item) => item.status === "succeeded")
      .sort((a, b) => minor(a.created) - minor(b.created) || a.id.localeCompare(b.id));
    const cumulative = successful.reduce((sum, item) => minor(sum + minor(item.amount, true)), 0);
    if (cumulative !== minor(charge.amount_refunded) || cumulative > minor(charge.amount, true))
      refuse("refund_total_unresolved");
    if (options.realm && grant.customerId)
      await boundCustomer(grant.organizationId, grant.customerId);
    if (grant.sourceType !== "payment-intent") await store.grant(grant);
    if (!successful.length) {
      if (pending) return { outcome: "deferred", detail: "refund_pending" };
      await store.unfreezeFunding({
        organizationId: grant.organizationId,
        fundingRef: grant.fundingRef,
        fenceGeneration,
        cumulativeRefundedMicros: 0,
      });
      return { outcome: "applied", detail: "refund_status_recorded" };
    }
    const refundSource = await stripeRefundSource(sql);
    if (!refundSource) refuse("refund_schema_unavailable");
    const recorded = await sql.query(
      `SELECT refund_id, amount_micros, cumulative_refunded_micros FROM ${refundSource} WHERE org_id = ? AND funding_ref = ? ORDER BY cumulative_refunded_micros`,
      [grant.organizationId, grant.fundingRef],
    );
    const recordedIds = new Set(recorded.map((row) => String(row.refund_id)));
    const prefix = recorded.map((row) => {
      const actual = successful.find((item) => item.id === row.refund_id);
      if (!actual || cashMicros(minor(actual.amount, true)) !== Number(row.amount_micros))
        refuse("refund_total_unresolved");
      return actual;
    });
    successful = [...prefix, ...successful.filter((item) => !recordedIds.has(item.id))];
    let amount = 0;
    for (let i = 0; i < successful.length; i++) {
      const refund = successful[i];
      if (!refund) continue;
      amount = minor(amount + minor(refund.amount, true));
      if (options.realm && grant.customerId)
        await boundCustomer(grant.organizationId, grant.customerId);
      await store.refund({
        refundId: refund.id,
        grant,
        amountMicros: cashMicros(minor(refund.amount, true)),
        cumulativeRefundedMicros: cashMicros(amount),
        fenceGeneration,
        releaseFreeze: !pending && i === successful.length - 1,
        ...(native === null ? {} : { native }),
      });
    }
    if (grant.subscriptionId) await updateSubscription(grant.subscriptionId);
    return pending
      ? { outcome: "deferred", detail: "refund_pending" }
      : { outcome: "applied", detail: "refund_settled" };
  }
  async function recoverCardSetupSession(
    session: StripeBillingObject,
  ): Promise<StripeEventHandling> {
    if (!cardSetup) return { outcome: "ignored", detail: "not_hosted_card_setup" };
    noConnect(session);
    if (session.livemode !== livemode) refuse("wrong_account_or_mode");
    const meta = session.metadata == null ? {} : metadata(session.metadata);
    const candidates = await sql.query(
      `SELECT * FROM stripe_billing_card_setup_commands
       WHERE session_id = ? OR (session_id IS NULL AND org_id = ? AND reference = ?) LIMIT 2`,
      [
        session.id,
        typeof meta.organizationId === "string" ? meta.organizationId : "",
        typeof meta.reference === "string" ? meta.reference : "",
      ],
    );
    if (!candidates.length) return { outcome: "ignored", detail: "not_hosted_card_setup" };
    const original = candidates[0];
    if (candidates.length !== 1 || !original) refuse("card_setup_original_unresolved");
    const expected = {
      organizationId: original.org_id,
      reference: original.reference,
      fingerprint: original.fingerprint,
      setupDisclosureRevision: original.disclosure_revision,
      stripeAccountId: original.account_id,
      financialRealm: original.financial_realm,
      billingAuthority: original.billing_authority,
    };
    if (
      Object.keys(meta).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => meta[key] !== value)
    )
      refuse("card_setup_original_unresolved");
    const receipt = await cardSetup.recoverOriginal(
      String(original.org_id),
      String(original.reference),
    );
    if (receipt?.state === "succeeded" || receipt?.state === "canceled")
      return { outcome: "applied", detail: "card_setup_recorded" };
    if (receipt?.sessionExpired)
      return { outcome: "applied", detail: "card_setup_session_expired" };
    return { outcome: "deferred", detail: "card_setup_pending" };
  }
  async function recoverOnDemandIntent(paymentIntentId: string): Promise<StripeEventHandling> {
    if (!onDemand) return { outcome: "ignored", detail: "not_hosted_on_demand" };
    const receipt = await onDemand.drainForPaymentIntent(paymentIntentId);
    if (!receipt) return { outcome: "ignored", detail: "not_hosted_on_demand" };
    if (receipt.state === "pending" || receipt.state === "funded") {
      const proof = await onDemand.readFundingProofForPaymentIntent(paymentIntentId);
      if (proof && proof.refundedAmountMinor > 0) return await refundCharge(proof.chargeId);
    }
    return receipt.state === "funded" ||
      receipt.state === "canceled" ||
      receipt.state === "abandoned"
      ? { outcome: "applied", detail: "on_demand_original_recorded" }
      : { outcome: "deferred", detail: "on_demand_original_pending" };
  }
  async function apply(event: StripeEventEnvelope): Promise<StripeEventHandling> {
    await ready();
    if (event.livemode !== livemode || event.account != null)
      return { outcome: "ignored", detail: "wrong_account_or_mode" };
    if (!event.objectId) return { outcome: "ignored", detail: "unexpected_object" };
    try {
      if (event.type === "payment_intent.succeeded" || event.type === "payment_intent.canceled")
        return await recoverOnDemandIntent(identifier(event.objectId, "pi"));
      if (event.type.startsWith("customer.subscription."))
        return await updateSubscription(identifier(event.objectId, "sub"));
      if (event.type.startsWith("invoice.")) {
        const invoice = await client.get("invoices", identifier(event.objectId, "in"));
        if (!invoice) refuse("unknown_invoice");
        if (await unrelatedInvoice(invoice))
          return { outcome: "ignored", detail: "not_hosted_subscription" };
        if (invoice.status === "paid") {
          const grant = await invoiceGrant(invoice.id);
          await settleGrant(grant);
          if (grant.subscriptionId) await updateSubscription(grant.subscriptionId);
          return { outcome: "applied", detail: "invoice_credit_granted" };
        }
        if (invoice.subscription == null) refuse("unbound_subscription");
        const subscriptionId = identifier(invoice.subscription, "sub");
        const subscription = await client.get("subscriptions", subscriptionId);
        if (!subscription) refuse("unknown_subscription");
        const facts = await subscriptionFacts(subscription);
        if (identifier(invoice.customer, "cus") !== facts.customer) refuse("wrong_customer");
        const pinned = metadata(record(invoice.subscription_details).metadata);
        const native = metadata(subscription.metadata);
        if (pinned.takoserverPurpose !== PURPOSE || pinned.organizationId !== facts.org)
          refuse("wrong_invoice_subscription");
        if (extensions) {
          usd(invoice);
          const snapshot = await tariff(pinned.pricingRevision),
            plan = paidPlan(snapshot, pinned.planKey);
          const lines = record(invoice.lines);
          if (
            !plan ||
            lines.has_more !== false ||
            !Array.isArray(lines.data) ||
            lines.data.length !== 1
          )
            refuse("unsupported_invoice_lines");
          const line = record(lines.data[0]),
            period = record(line.period);
          if (
            line.type !== "subscription" ||
            line.proration !== false ||
            line.quantity !== 1 ||
            identifier(line.subscription, "sub") !== subscriptionId ||
            identifier(line.price, "price") !== plan.stripePriceId
          )
            refuse("unsupported_invoice_line");
          await historicalAssociation(
            subscriptionId,
            facts.org,
            facts.customer,
            plan.planId,
            String(pinned.pricingRevision),
            plan.stripePriceId,
            plan.monthlyAmountMinor,
            plan.includedCreditMinor,
            timestamp(period.start),
            timestamp(period.end),
          );
        } else if (
          pinned.planKey !== native.planKey ||
          pinned.pricingRevision !== native.pricingRevision
        )
          refuse("wrong_invoice_subscription");
        assertInvoiceClaim(invoice, pinned);
        return await updateSubscription(subscriptionId);
      }
      if (event.type === "charge.refunded")
        return await refundCharge(identifier(event.objectId, "ch"));
      if (event.type.startsWith("refund.") || event.type === "charge.refund.updated") {
        const refund = await client.get("refunds", identifier(event.objectId, "re"));
        if (!refund) refuse("unknown_refund");
        return await refundCharge(identifier(refund.charge, "ch"));
      }
      if (event.type.startsWith("checkout.session.")) {
        const session = await client.get("checkout/sessions", identifier(event.objectId, "cs"));
        if (!session) refuse("unknown_session");
        if (session.mode === "setup") return await recoverCardSetupSession(session);
        if (session.mode === "subscription") {
          noConnect(session);
          const meta = session.metadata == null ? null : metadata(session.metadata);
          if (meta?.takoserverPurpose !== PURPOSE) {
            if (meta && hasHostedClaim(meta)) refuse("invalid_hosted_checkout");
            const subscriptionId = identifier(session.subscription, "sub");
            const subscription = await client.get("subscriptions", subscriptionId);
            if (!subscription) refuse("unknown_subscription");
            noConnect(subscription);
            const known = await sql.query(
              `SELECT 1 FROM stripe_billing_associations WHERE subscription_id = ?
               UNION SELECT 1 FROM stripe_billing_subscriptions WHERE subscription_id = ?
               UNION SELECT 1 FROM stripe_billing_grants WHERE subscription_id = ? LIMIT 1`,
              [subscriptionId, subscriptionId, subscriptionId],
            );
            if (
              known.length ||
              hasHostedClaim(subscription.metadata) ||
              (await isBoundHostedCustomer(subscription.customer))
            )
              refuse("invalid_hosted_checkout");
            return { outcome: "ignored", detail: "not_hosted_subscription" };
          }
          await custody.associateSession(session.id);
          return await updateSubscription(identifier(session.subscription, "sub"));
        }
        await settleGrant(await checkoutGrant(session.id));
        return { outcome: "credited", detail: "credited" };
      }
      return { outcome: "ignored", detail: "unsupported" };
    } catch (error) {
      if (error instanceof StripeBillingStoreError && error.code === "invoice_period_not_started")
        return { outcome: "deferred", detail: error.code };
      if (error instanceof SubscriptionPlanChangeError)
        return { outcome: "deferred", detail: "subscription_terms_unresolved" };
      if (error instanceof Quarantine) {
        const ignored = new Set([
          "not_wallet_funding",
          "unknown_organization",
          "not_paid",
          "invoice_not_paid",
        ]);
        return {
          outcome: ignored.has(error.reason) ? "ignored" : "deferred",
          detail: error.reason,
        };
      }
      if (error instanceof SubscriptionCustodyError)
        return { outcome: "deferred", detail: "subscription_custody_unresolved" };
      if (error instanceof StripeOnDemandError || error instanceof StripeCardSetupError)
        return { outcome: "deferred", detail: "on_demand_original_unresolved" };
      if (
        (error instanceof SqlError && error.code === "constraint") ||
        (error instanceof StripeBillingStoreError &&
          [
            "grant_conflict",
            "refund_conflict",
            "ambiguous_charge",
            "hold_conflict",
            "conservation_violated",
          ].includes(error.code))
      )
        return { outcome: "deferred", detail: "billing_object_conflict" };
      if (error instanceof StripeBillingClientError || error instanceof StripeBillingStoreError)
        throw new StripeBillingError("payment_unavailable");
      throw error;
    }
  }

  const creditFunding: FundingCredit = async (funding) => {
    await ready();
    const id = funding.fundingRef.slice("stripe:".length);
    const grant = await checkoutGrant(identifier(id, "cs"));
    if (
      grant.organizationId !== funding.organizationId ||
      grant.amountMicros !== cashMicros(funding.amountMinor) ||
      funding.currency !== "USD"
    )
      throw new StripeBillingError("settlement_conflict");
    const prior = await store.grantForSource("checkout", id);
    await settleGrant(grant);
    return prior ? "already_credited" : "credited";
  };

  const subscriptions: SubscriptionPayments = {
    planTable: pricing.hostedPlanTable,
    async read(org) {
      await ready();
      const instant = now();
      const row = (
        await sql.query(
          `SELECT s.*,
             (SELECT MAX(g.period_end) FROM stripe_billing_grants g
              WHERE g.org_id = s.org_id AND g.subscription_id = s.subscription_id
                AND g.source_type = 'invoice'
                AND NOT EXISTS (SELECT 1 FROM stripe_billing_refunds r
                  WHERE r.org_id = g.org_id AND r.funding_ref = g.funding_ref
                    AND r.cumulative_refunded_micros >= g.consideration_micros)) AS paid_coverage,
             EXISTS (SELECT 1 FROM stripe_billing_grants g
              WHERE g.org_id = s.org_id AND g.subscription_id = s.subscription_id
                AND g.source_type = 'invoice' AND g.period_start <= ? AND g.period_end > ?
                AND NOT EXISTS (SELECT 1 FROM stripe_billing_refunds r
                  WHERE r.org_id = g.org_id AND r.funding_ref = g.funding_ref
                    AND r.cumulative_refunded_micros >= g.consideration_micros)) AS active_paid_coverage,
             (SELECT COALESCE(SUM(r.receivable_micros), 0) FROM stripe_billing_refunds r
              WHERE r.org_id = s.org_id) AS refund_debt
           FROM stripe_billing_subscriptions s WHERE s.org_id = ?`,
          [instant, instant, org],
        )
      )[0];
      if (!row) return null;
      const bound = await custody.association(String(row.subscription_id));
      if (!bound || bound.organizationId !== org || bound.customerId !== row.customer_id)
        throw new StripeBillingError("unbound_subscription", 409);
      return { ...subscriptionView(row), subscriptionRef: await custody.subscriptionRef(bound) };
    },
    async begin(input) {
      await ready();
      await exists(input.organizationId);
      if (!options.consoleOrigin) throw new StripeBillingError("not_found", 404);
      try {
        return await custody.begin(input.organizationId, input.reference, input.planKey);
      } catch (error) {
        if (error instanceof SubscriptionCustodyError)
          throw new StripeBillingError(
            error.code,
            ["unknown_plan", "invalid_argument"].includes(error.code) ? 400 : 409,
          );
        throw error;
      }
    },
    async change(input) {
      await ready();
      await exists(input.organizationId);
      if (input.cancelAtPeriodEnd !== true || !input.expectedSubscriptionRef)
        throw new StripeBillingError("subscription_management_conflict", 409);
      try {
        if (extensions) return await extensions.cancel(input);
        return await custody.cancel(
          input.organizationId,
          input.reference,
          input.expectedSubscriptionRef,
        );
      } catch (error) {
        if (error instanceof SubscriptionCustodyError)
          throw new StripeBillingError(
            error.code,
            error.code === "subscription_management_not_found" ? 404 : 409,
          );
        throw error;
      }
    },
  };
  function subscriptionView(row: Row) {
    const paidThrough = row.paid_coverage == null ? null : String(row.paid_coverage);
    return {
      organizationId: String(row.org_id),
      subscriptionId: String(row.subscription_id),
      planKey: String(row.plan_key),
      pricingRevision: String(row.pricing_revision),
      status: String(row.status),
      cancelAtPeriodEnd: row.cancel_at_period_end === 1,
      periodStart: String(row.period_start),
      periodEnd: String(row.period_end),
      paidThrough,
      paidFeatures:
        row.status === "active" &&
        Number(row.active_paid_coverage) === 1 &&
        paidThrough !== null &&
        paidThrough > now() &&
        Number(row.refund_debt) === 0,
      updatedAt: String(row.updated_at),
    };
  }
  const handlers: Record<string, StripeEventHandler> = Object.fromEntries(
    [
      ...eventTypes,
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      ...(cardSetup ? ["checkout.session.expired"] : []),
    ].map((type) => [type, (event: StripeEventEnvelope) => apply(event)]),
  );
  async function reconcile(): Promise<BillingReconcileReport> {
    await ready();
    let examined = 0,
      applied = 0,
      failedStreams = 0,
      truncated = false;
    let custodyUnresolved = 0;
    try {
      const recovered = await custody.reconcilePending();
      examined += recovered.examined;
      applied += recovered.applied;
      custodyUnresolved += recovered.unresolved;
      truncated ||= recovered.truncated;
    } catch {
      failedStreams++;
      truncated = true;
    }
    if (extensions) {
      try {
        const recovered = await extensions.plans.reconcilePending();
        examined += recovered.examined;
        applied += recovered.applied;
        custodyUnresolved += recovered.unresolved;
        truncated ||= recovered.truncated;
      } catch {
        failedStreams++;
        truncated = true;
      }
    }
    if (onDemand) {
      try {
        const recovered = await onDemand.drainPending(100);
        examined += recovered.length;
        applied += recovered.filter((receipt) =>
          ["funded", "canceled", "abandoned"].includes(receipt.state),
        ).length;
        custodyUnresolved += recovered.filter((receipt) =>
          ["prepared", "pending"].includes(receipt.state),
        ).length;
        truncated ||= recovered.length === 100;
      } catch {
        failedStreams++;
        truncated = true;
      }
    }
    if (cardSetup) {
      try {
        await sql.run(
          "INSERT OR IGNORE INTO stripe_billing_reconcile (stream, cursor, cycle_started_at, updated_at) VALUES ('card-setup', NULL, ?, ?)",
          [now(), now()],
        );
        const checkpoint = (
          await sql.query(
            "SELECT cursor, generation FROM stripe_billing_reconcile WHERE stream = 'card-setup'",
          )
        )[0];
        const cursor = checkpoint?.cursor == null ? null : String(checkpoint.cursor);
        const after: unknown = cursor === null ? null : JSON.parse(cursor);
        if (
          after !== null &&
          (!Array.isArray(after) ||
            after.length !== 2 ||
            after.some((value) => typeof value !== "string"))
        )
          refuse("card_setup_cursor_unresolved");
        const [afterOrg, afterReference] =
          after === null ? [null, null] : (after as [string, string]);
        const pending = await sql.query(
          `SELECT org_id, reference FROM stripe_billing_card_setup_commands
           WHERE state IN ('dispatched', 'original-known')
             AND (? IS NULL OR org_id > ? OR (org_id = ? AND reference > ?))
           ORDER BY org_id, reference LIMIT 100`,
          [afterOrg, afterOrg, afterOrg, afterReference],
        );
        let unresolved = 0;
        for (const original of pending) {
          examined++;
          try {
            const receipt = await cardSetup.recoverOriginal(
              String(original.org_id),
              String(original.reference),
            );
            if (receipt?.state === "succeeded" || receipt?.state === "canceled") applied++;
            else unresolved++;
          } catch {
            unresolved++;
          }
        }
        const more = pending.length === 100;
        const last = pending.at(-1);
        const next =
          more && last ? canonicalJson([String(last.org_id), String(last.reference)]) : null;
        await sql.run(
          `UPDATE stripe_billing_reconcile SET cursor = ?, generation = generation + 1,
           cycle_unresolved = CASE WHEN ? THEN cycle_unresolved + ? ELSE 0 END,
           last_unresolved = CASE WHEN ? THEN last_unresolved ELSE cycle_unresolved + ? END,
           updated_at = ?, cycle_started_at = CASE WHEN ? THEN cycle_started_at ELSE ? END
           WHERE stream = 'card-setup' AND cursor IS ? AND generation = ?`,
          [
            next,
            more ? 1 : 0,
            unresolved,
            more ? 1 : 0,
            unresolved,
            now(),
            more ? 1 : 0,
            now(),
            cursor,
            Number(checkpoint?.generation),
          ],
        );
        truncated ||= more;
      } catch {
        failedStreams++;
        truncated = true;
      }
    }
    async function attempt(event: StripeEventEnvelope): Promise<StripeEventHandling> {
      let result: StripeEventHandling;
      try {
        result = await apply(event);
      } catch (error) {
        const code = error instanceof StripeBillingError ? error.code : "payment_unavailable";
        result = {
          outcome: "deferred",
          detail: /^[a-z_]{1,64}$/u.test(code) ? code : "payment_unavailable",
        };
      }
      if (event.objectId !== null) {
        if (result.outcome === "deferred") {
          await sql.run(
            `INSERT INTO stripe_billing_reconcile_failures
              (event_type, object_id, error_code, attempt_sequence, updated_at)
             SELECT ?, ?, ?, COALESCE(MAX(attempt_sequence), 0) + 1, ?
             FROM stripe_billing_reconcile_failures WHERE 1
             ON CONFLICT(event_type, object_id) DO UPDATE SET
               error_code = excluded.error_code, attempt_sequence = excluded.attempt_sequence,
               updated_at = excluded.updated_at`,
            [event.type, event.objectId, result.detail ?? "payment_unavailable", now()],
          );
          console.warn(
            JSON.stringify({
              event: "takoserver.stripe.billing_reconcile_object_deferred",
              type: event.type,
              objectId: /^[A-Za-z0-9_]{1,255}$/u.test(event.objectId)
                ? event.objectId
                : "invalid_object",
              code: result.detail,
            }),
          );
        } else {
          await sql.run(
            "DELETE FROM stripe_billing_reconcile_failures WHERE event_type = ? AND object_id = ?",
            [event.type, event.objectId],
          );
        }
      }
      return result;
    }
    try {
      const retry = await sql.query(
        "SELECT event_type, object_id FROM stripe_billing_reconcile_failures ORDER BY attempt_sequence, event_type, object_id LIMIT 100",
      );
      for (const row of retry) {
        examined++;
        try {
          const result = await attempt({
            id: `retry:${String(row.object_id)}`,
            type: String(row.event_type),
            objectId: String(row.object_id),
            objectType: null,
            created: 1,
            livemode,
            account: null,
          });
          if (result.outcome === "applied" || result.outcome === "credited") applied++;
        } catch {
          failedStreams++;
          truncated = true;
        }
      }
    } catch {
      failedStreams++;
      truncated = true;
    }
    for (const stream of ["invoices", "subscriptions", "refunds", "replay"] as const) {
      let pageUnresolved = 0;
      try {
        await sql.run(
          "INSERT OR IGNORE INTO stripe_billing_reconcile (stream, cursor, cycle_started_at, updated_at) VALUES (?, NULL, ?, ?)",
          [stream, now(), now()],
        );
        const checkpoint = (
          await sql.query(
            "SELECT cursor, generation FROM stripe_billing_reconcile WHERE stream = ?",
            [stream],
          )
        )[0];
        const cursor = checkpoint?.cursor == null ? undefined : String(checkpoint.cursor);
        let events: StripeEventEnvelope[] = [],
          next: string | null = null,
          more = false;
        try {
          if (stream === "replay") {
            const rows = await sql.query(
              "SELECT event_id, type, livemode, object_id FROM stripe_events WHERE handler_version < 1 AND type IN (SELECT value FROM json_each(?)) AND (? IS NULL OR event_id > ?) ORDER BY event_id LIMIT 100",
              [JSON.stringify(eventTypes), cursor ?? null, cursor ?? null],
            );
            for (const row of rows) {
              const event = await client.get("events", String(row.event_id));
              if (!event) {
                // Stripe retains Events for 30 days. A previously authenticated
                // identity is sufficient to request its object under this account's
                // test key. That object must still pass mode, Connect, customer,
                // purpose and tariff checks; no envelope supplies money authority.
                events.push({
                  id: String(row.event_id),
                  type: String(row.type),
                  livemode: row.livemode === 1,
                  account: null,
                  created: 1,
                  objectId: row.object_id == null ? null : String(row.object_id),
                  objectType: null,
                });
                continue;
              }
              const object = record(record(event.data).object);
              events.push({
                id: event.id,
                type: String(event.type),
                livemode: event.livemode === true,
                account: typeof event.account === "string" ? event.account : null,
                created: minor(event.created, true),
                objectId: typeof object.id === "string" ? object.id : null,
                objectType: typeof object.object === "string" ? object.object : null,
              });
            }
            next = rows.length === 100 ? String(rows.at(-1)?.event_id) : null;
            more = rows.length === 100;
          } else {
            const page = await client.list(stream, {
              ...(cursor ? { startingAfter: cursor } : {}),
              limit: 100,
            });
            events = page.data.map((object) => ({
              id: `reconcile:${object.id}`,
              type:
                stream === "invoices"
                  ? "invoice.paid"
                  : stream === "subscriptions"
                    ? "customer.subscription.updated"
                    : "refund.updated",
              livemode,
              account: null,
              created: 1,
              objectId: object.id,
              objectType: String(object.object),
            }));
            next = page.hasMore ? (page.data.at(-1)?.id ?? null) : null;
            more = page.hasMore;
          }
          for (const event of events) {
            examined++;
            const result = await attempt(event);
            if (result.outcome === "deferred") pageUnresolved++;
            else {
              if (result.outcome === "applied" || result.outcome === "credited") applied++;
              if (stream === "replay")
                await sql.run(
                  "UPDATE stripe_events SET outcome = ?, outcome_detail = ?, settled_at = ?, handler_version = 1 WHERE event_id = ? AND handler_version < 1",
                  [result.outcome, result.detail, now(), event.id],
                );
            }
          }
        } catch {
          // Keep this stream at its durable cursor, but continue the independent
          // streams so an unavailable invoice cannot starve a successful refund.
          pageUnresolved++;
          next = cursor ?? null;
          more = true;
        }
        // Each pass advances at most a page per stream. Competing passes cannot
        // regress a cursor, including the NULL at a new sweep. Errors remain
        // visible until an entire subsequent sweep completes without an error.
        await sql.run(
          `UPDATE stripe_billing_reconcile SET cursor = ?, generation = generation + 1,
          cycle_unresolved = CASE WHEN ? THEN cycle_unresolved + ? ELSE 0 END,
          last_unresolved = CASE WHEN ? THEN last_unresolved ELSE cycle_unresolved + ? END,
          updated_at = ?, cycle_started_at = CASE WHEN ? THEN cycle_started_at ELSE ? END
          WHERE stream = ? AND cursor IS ? AND generation = ?`,
          [
            next,
            more ? 1 : 0,
            pageUnresolved,
            more ? 1 : 0,
            pageUnresolved,
            now(),
            more ? 1 : 0,
            now(),
            stream,
            cursor ?? null,
            Number(checkpoint?.generation),
          ],
        );
        truncated ||= more;
      } catch {
        // A checkpoint/storage failure is visible in this pass and does not
        // stop attempts on the remaining independently recoverable streams.
        failedStreams++;
        truncated = true;
      }
    }
    const outstanding = (
      await sql.query(
        "SELECT COALESCE(SUM(MAX(cycle_unresolved, last_unresolved)), 0) AS unresolved FROM stripe_billing_reconcile",
      )
    )[0];
    const queued = (
      await sql.query("SELECT COUNT(*) AS count FROM stripe_billing_reconcile_failures")
    )[0];
    const unresolved =
      Number(outstanding?.unresolved ?? 0) +
      Number(queued?.count ?? 0) +
      custodyUnresolved +
      failedStreams;
    const report = { examined, applied, unresolved, truncated, handlerVersion: 1 as const };
    if (unresolved || truncated)
      console.warn(
        JSON.stringify({ event: "takoserver.stripe.billing_reconcile_incomplete", ...report }),
      );
    return report;
  }
  return {
    subscriptions,
    subscriptionPlans: extensions?.plans,
    subscriptionCommandReceipts:
      options.realm && extensions
        ? createSubscriptionCommandReceipts({
            readStart: custody.readStartCommand,
            readNativeCancel: custody.readCancelCommand,
            readExtension: extensions.plans.readCommand,
          })
        : undefined,
    handlers,
    creditFunding,
    reconcile,
  };
}

export async function assertStripeBillingSchema(sql: Sql): Promise<void> {
  const names = [
    "stripe_billing_pricing",
    "stripe_billing_price_identity",
    "stripe_billing_price_identity_checks",
    "stripe_subscription_custody_reconcile",
    "stripe_billing_grants",
    "stripe_billing_customers",
    "stripe_billing_subscriptions",
    "stripe_billing_commands",
    "stripe_billing_reconcile",
    "stripe_billing_object_claims",
    "stripe_billing_refund_observations",
    "stripe_billing_checkouts",
    "stripe_billing_fences",
    "stripe_billing_refunds",
    "stripe_billing_reconcile_failures",
    "stripe_subscription_checkout_intents",
    "stripe_billing_associations",
    "stripe_subscription_cancellation_intents",
  ];
  const rows = await sql.query(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (SELECT value FROM json_each(?))",
    [JSON.stringify(names)],
  );
  if (rows.length !== names.length) throw new StripeBillingError("stripe_billing_schema_not_ready");
  const columns = await sql.query("PRAGMA table_info(stripe_events)");
  if (!columns.some((row) => row.name === "handler_version"))
    throw new StripeBillingError("stripe_billing_schema_not_ready");
  const reconcileColumns = await sql.query("PRAGMA table_info(stripe_billing_reconcile)");
  if (
    !["generation", "cycle_unresolved", "last_unresolved"].every((name) =>
      reconcileColumns.some((row) => row.name === name),
    )
  )
    throw new StripeBillingError("stripe_billing_schema_not_ready");
  const moneyColumns: Readonly<Record<string, readonly string[]>> = {
    stripe_billing_grants: ["amount_micros", "consideration_micros", "consumption_class"],
    stripe_billing_refunds: [
      "amount_micros",
      "cumulative_refunded_micros",
      "target_revoked_micros",
      "debit_micros",
      "receivable_micros",
      "expired_micros",
    ],
    org_wallet_holds: ["amount_micros", "money_policy", "closure_reason"],
  };
  for (const [table, required] of Object.entries(moneyColumns)) {
    const actual = await sql.query(`PRAGMA table_info(${table})`);
    if (!required.every((name) => actual.some((row) => row.name === name)))
      throw new StripeBillingError("stripe_billing_schema_not_ready");
  }
}

export function stripeBillingFailure(error: unknown): StripeBillingError | null {
  if (error instanceof StripeBillingError) return error;
  if (error instanceof Quarantine) return new StripeBillingError(error.reason, 409);
  if (error instanceof StripeBillingClientError)
    return new StripeBillingError("payment_unavailable");
  if (error instanceof StripeBillingStoreError)
    return new StripeBillingError("payment_unavailable");
  return null;
}
