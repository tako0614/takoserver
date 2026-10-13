import { parseBillingConfig } from "./billing-config.ts";
import { type HostedPricing, parseHostedPricing } from "./hosted-pricing.ts";
import { bytesDigest, canonicalJson } from "./json.ts";
import type { FundingCredit, PaymentEventContext } from "./payment-events.ts";
import { type Row, type Sql, SqlError } from "./ports.ts";
import {
  type StripeBillingClient,
  StripeBillingClientError,
  type StripeBillingObject,
} from "./stripe-billing-client.ts";
import {
  type BillingGrant,
  createStripeBillingStore,
  StripeBillingStoreError,
} from "./stripe-billing-store.ts";
import type {
  StripeEventEnvelope,
  StripeEventHandler,
  StripeEventHandling,
} from "./stripe-events.ts";

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
function timestamp(value: unknown): string {
  const seconds = minor(value, true);
  if (seconds > 253402300799) refuse("invalid_period");
  return new Date(seconds * 1000).toISOString();
}
function metadata(value: unknown): Record<string, unknown> {
  return record(value);
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
function reference(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value))
    throw new StripeBillingError("invalid_argument", 400);
}

export interface SubscriptionPayments {
  readonly planTable: HostedPricing["hostedPlanTable"];
  read(organizationId: string): Promise<Record<string, unknown> | null>;
  begin(input: {
    organizationId: string;
    reference: string;
    planKey: string;
  }): Promise<{ url: string }>;
  change(input: {
    organizationId: string;
    reference: string;
    cancelAtPeriodEnd: boolean;
  }): Promise<Record<string, unknown> | null>;
}
export interface BillingReconcileReport {
  readonly examined: number;
  readonly applied: number;
  readonly unresolved: number;
  readonly truncated: boolean;
  readonly handlerVersion: 1;
}

/** Explicitly opted-in hosted test-mode billing, using processor identities only. */
export function createStripeBilling(options: {
  readonly client: StripeBillingClient;
  readonly context: PaymentEventContext;
  readonly pricing: HostedPricing;
  readonly consoleOrigin?: string | undefined;
}) {
  const { client, context, pricing } = options;
  const { sql, clock } = context;
  const store = createStripeBillingStore({ sql, clock });
  const parsedBilling = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
  if (!parsedBilling) throw new StripeBillingError("billing_configuration_invalid");
  const billing = parsedBilling;
  const now = () => clock().toISOString();
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
    await assertStripeBillingSchema(sql);
    const json = canonicalJson(pricing);
    await sql.run(
      "INSERT OR IGNORE INTO stripe_billing_pricing (revision, config_json) VALUES (?, ?)",
      [billing?.revision ?? "", json],
    );
    const rows = await sql.query(
      "SELECT config_json FROM stripe_billing_pricing WHERE revision = ?",
      [billing?.revision ?? ""],
    );
    if (rows[0]?.config_json !== json) throw new StripeBillingError("pricing_revision_conflict");
  }
  async function tariff(revision: unknown): Promise<HostedPricing> {
    if (typeof revision !== "string") refuse("pricing_revision_unavailable");
    const rows = await sql.query(
      "SELECT config_json FROM stripe_billing_pricing WHERE revision = ?",
      [revision],
    );
    if (!rows[0]) refuse("pricing_revision_unavailable");
    const snapshot = JSON.parse(String(rows[0].config_json)) as HostedPricing;
    const parsed = parseHostedPricing(snapshot.environment.TAKOSERVER_HOSTED_PRICING);
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
    const rows = await sql.query(
      "SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?",
      [org],
    );
    if (rows[0]?.customer_id !== customer) refuse("wrong_customer");
    const object = await client.get("customers", customer);
    if (
      !object ||
      metadata(object.metadata).organizationId !== org ||
      metadata(object.metadata).takoserverPurpose !== PURPOSE
    )
      refuse("wrong_customer");
    noConnect(object);
  }
  async function price(id: string, table: HostedPricing): Promise<void> {
    const plan = table.hostedPlanTable.plans[1];
    if (plan.stripePriceId !== id) refuse("wrong_price");
    const object = await client.get("prices", id);
    if (!object) refuse("unknown_price");
    const recurring = record(object.recurring);
    usd(object);
    if (
      object.type !== "recurring" ||
      object.billing_scheme !== "per_unit" ||
      object.transform_quantity != null ||
      object.unit_amount !== plan.monthlyAmountMinor ||
      recurring.interval !== "month" ||
      recurring.interval_count !== 1 ||
      recurring.usage_type !== "licensed"
    )
      refuse("unsupported_plan");
  }
  async function subscriptionFacts(object: StripeBillingObject, table?: HostedPricing) {
    noConnect(object);
    const meta = metadata(object.metadata);
    if (meta.takoserverPurpose !== PURPOSE) refuse("not_hosted_subscription");
    const org = await exists(meta.organizationId);
    const customer = identifier(object.customer, "cus");
    await boundCustomer(org, customer);
    const snapshot = table ?? (await tariff(meta.pricingRevision));
    const plan = snapshot.hostedPlanTable.plans[1];
    if (meta.planKey !== plan.planId) refuse("wrong_plan");
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
    const facts = await subscriptionFacts(object);
    const paid = await sql.query(
      "SELECT MAX(period_end) AS paid_through FROM stripe_billing_grants g WHERE org_id = ? AND subscription_id = ? AND source_type = 'invoice' AND NOT EXISTS (SELECT 1 FROM stripe_billing_refunds r WHERE r.org_id = g.org_id AND r.funding_ref = g.funding_ref AND r.cumulative_refunded_minor >= g.consideration_minor)",
      [facts.org, id],
    );
    await sql.run(
      `INSERT INTO stripe_billing_subscriptions
      (org_id, subscription_id, customer_id, plan_key, pricing_revision, status, cancel_at_period_end, period_start, period_end, paid_through, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM stripe_billing_object_claims WHERE object_id = ? AND generation = ?)
      ON CONFLICT(org_id) DO UPDATE SET subscription_id = excluded.subscription_id, customer_id = excluded.customer_id,
        plan_key = excluded.plan_key, pricing_revision = excluded.pricing_revision, status = excluded.status,
        cancel_at_period_end = excluded.cancel_at_period_end, period_start = excluded.period_start,
        period_end = excluded.period_end, paid_through = excluded.paid_through, updated_at = excluded.updated_at
      WHERE stripe_billing_subscriptions.subscription_id = excluded.subscription_id OR stripe_billing_subscriptions.status IN ('canceled','incomplete_expired')`,
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
      ],
    );
    const current = (
      await sql.query("SELECT subscription_id FROM stripe_billing_subscriptions WHERE org_id = ?", [
        facts.org,
      ])
    )[0];
    if (current?.subscription_id !== id) refuse("multiple_subscriptions");
    return { outcome: "applied", detail: "subscription_updated" };
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
    const snapshot = await tariff(pinned.pricingRevision);
    const plan = snapshot.hostedPlanTable.plans[1];
    if (
      pinned.planKey !== plan.planId ||
      metadata(sub.metadata).organizationId !== pinned.organizationId
    )
      refuse("wrong_plan");
    const org = await exists(pinned.organizationId);
    const customer = identifier(invoice.customer, "cus");
    if (identifier(sub.customer, "cus") !== customer) refuse("wrong_customer");
    await boundCustomer(org, customer);
    const existingSubscription = (
      await sql.query(
        "SELECT subscription_id, status FROM stripe_billing_subscriptions WHERE org_id = ?",
        [org],
      )
    )[0];
    if (
      existingSubscription &&
      existingSubscription.subscription_id !== subscriptionId &&
      !["canceled", "incomplete_expired"].includes(String(existingSubscription.status))
    )
      refuse("multiple_subscriptions");
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
    const consideration = minor(invoice.amount_paid, true);
    if (
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
    return {
      organizationId: org,
      fundingRef: `stripe:invoice:${id}`,
      kind: "plan-included",
      amountMinor: plan.includedCreditMinor,
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
      considerationMinor: consideration,
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
  async function checkoutGrant(id: string): Promise<BillingGrant> {
    const session = await client.get("checkout/sessions", id, {
      expand: ["payment_intent.latest_charge"],
    });
    if (!session) refuse("unknown_session");
    usd(session);
    noConnect(session);
    const meta = metadata(session.metadata);
    if (session.mode !== "payment" || meta.takoserverPurpose !== "wallet_funding")
      refuse("not_wallet_funding");
    if (session.payment_status !== "paid" || session.status !== "complete") refuse("not_paid");
    const org = await exists(meta.organizationId);
    const amount = minor(session.amount_total, true);
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
    const prior = await store.grantForSource("checkout", id);
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
    if (!prior && !legacy && !snapshot) refuse("pricing_history_missing");
    const expiry = snapshot?.purchaseCreditExpiry;
    const expiresAt = prior
      ? prior.expiresAt
      : legacy?.kind === "direct"
        ? legacy.expires_at == null
          ? null
          : String(legacy.expires_at)
        : expiry?.kind === "fixed-duration"
          ? new Date(Date.parse(now()) + expiry.seconds * 1000).toISOString()
          : null;
    return {
      organizationId: org,
      fundingRef: `stripe:${id}`,
      kind: "purchased",
      amountMinor: amount,
      expiresAt,
      sourceType: "checkout",
      sourceId: id,
      chargeId,
      customerId: customer,
      subscriptionId: null,
      planKey: null,
      pricingRevision: prior ? prior.pricingRevision : legacy ? null : (snapshot?.revision ?? null),
      stripePriceId: null,
      periodStart: null,
      periodEnd: null,
      considerationMinor: amount,
    };
  }

  async function settleGrant(grant: BillingGrant): Promise<void> {
    const charge = await client.get("charges", grant.chargeId);
    if (!charge) refuse("unknown_charge");
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
    if (!grant) {
      if (charge.invoice != null) grant = await invoiceGrant(identifier(charge.invoice, "in"));
      else {
        const sessions = await client.list("checkout/sessions", {
          paymentIntent: identifier(charge.payment_intent, "pi"),
          limit: 100,
        });
        if (sessions.hasMore || sessions.data.length !== 1) refuse("ambiguous_refund_allocation");
        grant = await checkoutGrant(sessions.data[0]?.id ?? "");
      }
    }
    if (grant.chargeId !== chargeId || grant.considerationMinor !== minor(charge.amount, true))
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
    await store.grant(grant);
    if (!successful.length) {
      if (pending) return { outcome: "deferred", detail: "refund_pending" };
      await store.unfreezeFunding({
        organizationId: grant.organizationId,
        fundingRef: grant.fundingRef,
        fenceGeneration,
        cumulativeRefundedMinor: 0,
      });
      return { outcome: "applied", detail: "refund_status_recorded" };
    }
    const recorded = await sql.query(
      "SELECT refund_id, amount_minor, cumulative_refunded_minor FROM stripe_billing_refunds WHERE org_id = ? AND funding_ref = ? ORDER BY cumulative_refunded_minor",
      [grant.organizationId, grant.fundingRef],
    );
    const recordedIds = new Set(recorded.map((row) => String(row.refund_id)));
    const prefix = recorded.map((row) => {
      const actual = successful.find((item) => item.id === row.refund_id);
      if (!actual || actual.amount !== Number(row.amount_minor)) refuse("refund_total_unresolved");
      return actual;
    });
    successful = [...prefix, ...successful.filter((item) => !recordedIds.has(item.id))];
    let amount = 0;
    for (let i = 0; i < successful.length; i++) {
      const refund = successful[i];
      if (!refund) continue;
      amount = minor(amount + minor(refund.amount, true));
      await store.refund({
        refundId: refund.id,
        grant,
        amountMinor: minor(refund.amount, true),
        cumulativeRefundedMinor: amount,
        fenceGeneration,
        releaseFreeze: !pending && i === successful.length - 1,
      });
    }
    if (grant.subscriptionId) await updateSubscription(grant.subscriptionId);
    return pending
      ? { outcome: "deferred", detail: "refund_pending" }
      : { outcome: "applied", detail: "refund_settled" };
  }
  async function apply(event: StripeEventEnvelope): Promise<StripeEventHandling> {
    await ready();
    if (event.livemode || event.account != null)
      return { outcome: "ignored", detail: "wrong_account_or_mode" };
    if (!event.objectId) return { outcome: "ignored", detail: "unexpected_object" };
    try {
      if (event.type.startsWith("customer.subscription."))
        return await updateSubscription(identifier(event.objectId, "sub"));
      if (event.type.startsWith("invoice.")) {
        const invoice = await client.get("invoices", identifier(event.objectId, "in"));
        if (!invoice) refuse("unknown_invoice");
        if (invoice.status === "paid") {
          const grant = await invoiceGrant(invoice.id);
          await settleGrant(grant);
          if (grant.subscriptionId) await updateSubscription(grant.subscriptionId);
          return { outcome: "applied", detail: "invoice_credit_granted" };
        }
        if (invoice.subscription == null)
          return { outcome: "ignored", detail: "not_hosted_subscription" };
        return await updateSubscription(identifier(invoice.subscription, "sub"));
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
        if (session.mode === "subscription") {
          if (metadata(session.metadata).takoserverPurpose !== PURPOSE)
            refuse("not_hosted_subscription");
          return await updateSubscription(identifier(session.subscription, "sub"));
        }
        await settleGrant(await checkoutGrant(session.id));
        return { outcome: "credited", detail: "credited" };
      }
      return { outcome: "ignored", detail: "unsupported" };
    } catch (error) {
      if (error instanceof Quarantine) {
        const ignored = new Set([
          "not_hosted_subscription",
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
      grant.amountMinor !== funding.amountMinor ||
      funding.currency !== "USD"
    )
      throw new StripeBillingError("settlement_conflict");
    const prior = await store.grantForSource("checkout", id);
    await settleGrant(grant);
    return prior ? "already_credited" : "credited";
  };
  async function command(
    org: string,
    ref: string,
    kind: string,
    body: unknown,
    operation: (key: string) => Promise<Record<string, unknown>>,
  ) {
    await ready();
    reference(ref);
    await exists(org);
    const fingerprint = canonicalJson(body);
    const commandRef = `${kind}:${ref}`;
    await sql.run(
      "INSERT OR IGNORE INTO stripe_billing_commands (org_id, reference, fingerprint, kind, remote_id, response_json, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)",
      [org, commandRef, fingerprint, kind, now()],
    );
    const row = (
      await sql.query("SELECT * FROM stripe_billing_commands WHERE org_id = ? AND reference = ?", [
        org,
        commandRef,
      ])
    )[0];
    if (!row || row.fingerprint !== fingerprint)
      throw new StripeBillingError("reference_conflict", 409);
    if (row.response_json != null)
      return JSON.parse(String(row.response_json)) as Record<string, unknown>;
    // Stripe drops idempotency keys after 24h. An unknown ACK is then an operator
    // reconciliation task, never a fresh payment attempt.
    if (Date.parse(now()) - Date.parse(String(row.created_at)) >= 23 * 3600_000)
      throw new StripeBillingError("payment_command_unresolved", 409);
    const key = await bytesDigest(new TextEncoder().encode(canonicalJson([org, commandRef])));
    const result = await operation(key);
    await sql.run(
      "UPDATE stripe_billing_commands SET remote_id = ?, response_json = ? WHERE org_id = ? AND reference = ? AND fingerprint = ? AND response_json IS NULL",
      [
        typeof result.id === "string" ? result.id : null,
        canonicalJson(result),
        org,
        commandRef,
        fingerprint,
      ],
    );
    const committed = (
      await sql.query(
        "SELECT response_json FROM stripe_billing_commands WHERE org_id = ? AND reference = ?",
        [org, commandRef],
      )
    )[0];
    if (committed?.response_json !== canonicalJson(result))
      throw new StripeBillingError("payment_command_unresolved");
    return result;
  }
  async function customer(org: string): Promise<string> {
    const row = (
      await sql.query("SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?", [org])
    )[0];
    if (row) {
      await boundCustomer(org, String(row.customer_id));
      return String(row.customer_id);
    }
    const created = await command(org, "customer", "customer", {}, async (key) => {
      const result = await client.post("customers", {
        form: { "metadata[organizationId]": org, "metadata[takoserverPurpose]": PURPOSE },
        idempotencyKey: key,
      });
      if (
        metadata(result.metadata).organizationId !== org ||
        metadata(result.metadata).takoserverPurpose !== PURPOSE
      )
        refuse("wrong_customer");
      return { id: result.id };
    });
    const id = identifier(created.id, "cus");
    await sql.run(
      "INSERT OR IGNORE INTO stripe_billing_customers (org_id, customer_id, created_at) VALUES (?, ?, ?)",
      [org, id, now()],
    );
    await boundCustomer(org, id);
    return id;
  }
  const subscriptions: SubscriptionPayments = {
    planTable: pricing.hostedPlanTable,
    async read(org) {
      await ready();
      const row = (
        await sql.query(
          `SELECT s.*,
             (SELECT MAX(g.period_end) FROM stripe_billing_grants g
              WHERE g.org_id = s.org_id AND g.subscription_id = s.subscription_id
                AND g.source_type = 'invoice'
                AND NOT EXISTS (SELECT 1 FROM stripe_billing_refunds r
                  WHERE r.org_id = g.org_id AND r.funding_ref = g.funding_ref
                    AND r.cumulative_refunded_minor >= g.consideration_minor)) AS paid_coverage,
             (SELECT COALESCE(SUM(r.receivable_minor), 0) FROM stripe_billing_refunds r
              WHERE r.org_id = s.org_id) AS refund_debt
           FROM stripe_billing_subscriptions s WHERE s.org_id = ?`,
          [org],
        )
      )[0];
      return row ? subscriptionView(row) : null;
    },
    async begin(input) {
      await ready();
      reference(input.reference);
      if (!options.consoleOrigin) throw new StripeBillingError("not_found", 404);
      const plan = pricing.hostedPlanTable.plans[1];
      if (input.planKey !== plan.planId) throw new StripeBillingError("unknown_plan", 400);
      const priorCommand = (
        await sql.query(
          "SELECT fingerprint, response_json FROM stripe_billing_commands WHERE org_id = ? AND reference = ?",
          [input.organizationId, `checkout:${input.reference}`],
        )
      )[0];
      if (priorCommand?.response_json != null) {
        const priorInput = JSON.parse(String(priorCommand.fingerprint)) as { planKey?: string };
        if (priorInput.planKey !== input.planKey)
          throw new StripeBillingError("reference_conflict", 409);
        const response = JSON.parse(String(priorCommand.response_json)) as {
          id: string;
          url: string;
        };
        // The command receipt can commit before the Checkout reservation update
        // is acknowledged. Repair only this reference before returning it.
        await sql.run(
          "UPDATE stripe_billing_checkouts SET session_id = ? WHERE org_id = ? AND reference = ? AND (session_id IS NULL OR session_id = ?)",
          [response.id, input.organizationId, input.reference, response.id],
        );
        return { url: response.url };
      }
      if (billing.effectiveAt > now()) throw new StripeBillingError("pricing_not_effective", 409);
      const existing = await subscriptions.read(input.organizationId);
      if (existing && !["canceled", "incomplete_expired"].includes(String(existing.status)))
        throw new StripeBillingError("subscription_exists", 409);
      const claim = (
        await sql.query(
          "SELECT reference, session_id FROM stripe_billing_checkouts WHERE org_id = ?",
          [input.organizationId],
        )
      )[0];
      if (claim && claim.reference !== input.reference) {
        if (claim.session_id == null)
          throw new StripeBillingError("payment_command_unresolved", 409);
        const remote = await client.get("checkout/sessions", String(claim.session_id));
        if (
          !remote ||
          !(
            remote.status === "expired" ||
            (remote.status === "complete" &&
              existing &&
              ["canceled", "incomplete_expired"].includes(String(existing.status)))
          )
        )
          throw new StripeBillingError("subscription_checkout_pending", 409);
        await sql.run(
          "DELETE FROM stripe_billing_checkouts WHERE org_id = ? AND reference = ? AND session_id = ?",
          [input.organizationId, String(claim.reference), String(claim.session_id)],
        );
      }
      await sql.run(
        "INSERT OR IGNORE INTO stripe_billing_checkouts (org_id, reference, session_id, created_at) VALUES (?, ?, NULL, ?)",
        [input.organizationId, input.reference, now()],
      );
      const reserved = (
        await sql.query("SELECT reference FROM stripe_billing_checkouts WHERE org_id = ?", [
          input.organizationId,
        ])
      )[0];
      if (reserved?.reference !== input.reference)
        throw new StripeBillingError("subscription_checkout_pending", 409);
      await price(plan.stripePriceId, pricing);
      const customerId = await customer(input.organizationId);
      const result = await command(
        input.organizationId,
        input.reference,
        "checkout",
        { planKey: input.planKey, revision: billing.revision },
        async (key) => {
          const form: Record<string, string> = {
            mode: "subscription",
            customer: customerId,
            "line_items[0][price]": plan.stripePriceId,
            "line_items[0][quantity]": "1",
            success_url: `${options.consoleOrigin}/billing?subscription={CHECKOUT_SESSION_ID}`,
            cancel_url: `${options.consoleOrigin}/billing?subscription=cancelled`,
          };
          for (const [field, value] of Object.entries({
            organizationId: input.organizationId,
            takoserverPurpose: PURPOSE,
            planKey: plan.planId,
            pricingRevision: billing.revision,
          })) {
            form[`metadata[${field}]`] = value;
            form[`subscription_data[metadata][${field}]`] = value;
          }
          const remote = await client.post("checkout/sessions", { form, idempotencyKey: key });
          if (
            typeof remote.url !== "string" ||
            !remote.url.startsWith("https://checkout.stripe.com/")
          )
            refuse("invalid_checkout_url");
          return { id: remote.id, url: remote.url };
        },
      );
      await sql.run(
        "UPDATE stripe_billing_checkouts SET session_id = ? WHERE org_id = ? AND reference = ? AND (session_id IS NULL OR session_id = ?)",
        [String(result.id), input.organizationId, input.reference, String(result.id)],
      );
      return { url: String(result.url) };
    },
    async change(input) {
      await ready();
      const current = await subscriptions.read(input.organizationId);
      if (!current) throw new StripeBillingError("subscription_not_found", 404);
      const id = identifier(current.subscriptionId, "sub");
      await command(
        input.organizationId,
        input.reference,
        "cancel",
        { subscriptionId: id, cancelAtPeriodEnd: input.cancelAtPeriodEnd },
        async (key) => {
          const remote = await client.get("subscriptions", id);
          if (!remote || (await subscriptionFacts(remote)).org !== input.organizationId)
            refuse("wrong_subscription");
          await client.post("subscriptions", {
            id,
            form: { cancel_at_period_end: String(input.cancelAtPeriodEnd) },
            idempotencyKey: key,
          });
          return { id };
        },
      );
      await updateSubscription(id);
      return subscriptions.read(input.organizationId);
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
        paidThrough !== null &&
        paidThrough > now() &&
        Number(row.refund_debt) === 0,
      updatedAt: String(row.updated_at),
    };
  }
  const handlers: Record<string, StripeEventHandler> = Object.fromEntries(
    [...TYPES, "checkout.session.completed", "checkout.session.async_payment_succeeded"].map(
      (type) => [type, (event: StripeEventEnvelope) => apply(event)],
    ),
  );
  async function reconcile(): Promise<BillingReconcileReport> {
    await ready();
    let examined = 0,
      applied = 0,
      failedStreams = 0,
      truncated = false;
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
    const retry = await sql.query(
      "SELECT event_type, object_id FROM stripe_billing_reconcile_failures ORDER BY attempt_sequence, event_type, object_id LIMIT 100",
    );
    for (const row of retry) {
      examined++;
      const result = await attempt({
        id: `retry:${String(row.object_id)}`,
        type: String(row.event_type),
        objectId: String(row.object_id),
        objectType: null,
        created: 1,
        livemode: false,
        account: null,
      });
      if (result.outcome === "applied" || result.outcome === "credited") applied++;
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
              [JSON.stringify(TYPES), cursor ?? null, cursor ?? null],
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
              livemode: false,
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
      Number(outstanding?.unresolved ?? 0) + Number(queued?.count ?? 0) + failedStreams;
    const report = { examined, applied, unresolved, truncated, handlerVersion: 1 as const };
    if (unresolved || truncated)
      console.warn(
        JSON.stringify({ event: "takoserver.stripe.billing_reconcile_incomplete", ...report }),
      );
    return report;
  }
  return { subscriptions, handlers, creditFunding, reconcile };
}

export async function assertStripeBillingSchema(sql: Sql): Promise<void> {
  const names = [
    "stripe_billing_pricing",
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
