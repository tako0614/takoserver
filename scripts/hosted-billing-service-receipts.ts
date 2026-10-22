/** Read-only comparison of saved Stripe and selected-serving-D1 evidence DATA. */

import { createHash } from "node:crypto";
import { canonicalJson } from "../src/json.ts";
import type { BusinessInput } from "./hosted-billing-business-e2e.ts";

type RecordValue = Record<string, unknown>;

const MODERN_INVOICE_API_VERSION = "2026-05-27.dahlia";

export interface InvoiceSnapshotData {
  readonly modern: boolean;
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly metadata: RecordValue;
}

export interface ServiceReceiptContext {
  readonly input: BusinessInput;
  readonly targetSha256: string;
  readonly origin: string;
  readonly organizationId: string;
  readonly workerName: string;
  readonly d1DatabaseId: string;
  readonly stripeAccountId: string;
  readonly subscriptionCommand: unknown;
  readonly subscription: unknown;
  readonly topUpReceipt: unknown;
  readonly topUpAmountProven: boolean;
}

function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("service receipt evidence has invalid object");
  return value as RecordValue;
}

function exact(value: RecordValue, names: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...names].sort().join("\0"))
    throw new Error("service receipt evidence has missing or unexpected fields");
}

function requireEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error("service receipt evidence differs from original");
}

function identifier(value: unknown, prefix: string): string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9_]{1,240}$`, "u").test(value))
    throw new Error("service receipt evidence has invalid Stripe identity");
  return value;
}

function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("service receipt evidence has invalid timestamp");
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Parse only the invoice DATA shapes this matcher understands; callers retain the source snapshot. */
export function parseInvoiceSnapshot(
  eventValue: unknown,
  objectValue: unknown,
): InvoiceSnapshotData {
  const event = record(eventValue);
  const invoice = record(objectValue);
  const version = event.api_version;
  const modern = version === MODERN_INVOICE_API_VERSION;
  if (
    version !== undefined &&
    version !== null &&
    version !== MODERN_INVOICE_API_VERSION &&
    (typeof version !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(version) ||
      version >= "2026-05-27")
  )
    throw new Error("unsupported Stripe invoice event API version");

  let subscriptionId: string;
  let metadata: RecordValue;
  if (modern) {
    if (invoice.status !== "paid") throw new Error("modern invoice is not paid");
    if (
      !Number.isSafeInteger(invoice.amount_paid) ||
      (invoice.amount_paid as number) < 0 ||
      invoice.amount_remaining !== 0
    )
      throw new Error("modern invoice has invalid paid amounts");
    const paidAt = record(invoice.status_transitions).paid_at;
    if (
      !Number.isSafeInteger(paidAt) ||
      (paidAt as number) <= 0 ||
      !Number.isSafeInteger(event.created) ||
      (event.created as number) < (paidAt as number)
    )
      throw new Error("modern invoice has invalid paid time");
    const parent = record(invoice.parent);
    if (parent.type !== "subscription_details")
      throw new Error("modern invoice parent is not subscription details");
    const details = record(parent.subscription_details);
    subscriptionId = identifier(details.subscription, "sub");
    metadata = record(details.metadata);
    if (
      typeof metadata.subscriptionCheckoutIntentId !== "string" ||
      metadata.subscriptionCheckoutIntentId.length === 0
    )
      throw new Error("modern invoice lacks its subscription checkout intent");

    if (invoice.paid !== undefined && invoice.paid !== true)
      throw new Error("modern invoice conflicts with legacy paid alias");
    if (invoice.subscription !== undefined) requireEqual(invoice.subscription, subscriptionId);
    if (invoice.subscription_details !== undefined) {
      const legacy = record(record(invoice.subscription_details).metadata);
      for (const key of [
        "takoserverPurpose",
        "organizationId",
        "planKey",
        "pricingRevision",
        "subscriptionCheckoutIntentId",
      ])
        if (legacy[key] !== undefined) requireEqual(legacy[key], metadata[key]);
    }
  } else {
    if (Object.hasOwn(invoice, "parent"))
      throw new Error("legacy invoice contains a modern parent shape");
    if (invoice.status !== "paid") throw new Error("legacy invoice is not paid");
    requireEqual(invoice.paid, true);
    subscriptionId = identifier(invoice.subscription, "sub");
    metadata = record(record(invoice.subscription_details).metadata);
  }

  return {
    modern,
    subscriptionId,
    customerId: identifier(invoice.customer, "cus"),
    metadata,
  };
}

function eventAndReceipt(
  pairValue: unknown,
  type: "checkout.session.completed" | "invoice.paid",
  outcome: "credited" | "applied",
  detail: "credited" | "invoice_credit_granted",
): RecordValue {
  const pair = record(pairValue);
  exact(pair, ["stripeEvent", "serviceReceipt"]);
  const event = record(pair.stripeEvent);
  const row = record(pair.serviceReceipt);
  exact(row, [
    "event_id",
    "type",
    "livemode",
    "object_id",
    "event_created_at",
    "received_at",
    "outcome",
    "outcome_detail",
    "settled_at",
  ]);
  const eventId = identifier(event.id, "evt");
  requireEqual(event.type, type);
  requireEqual(event.livemode, false);
  if (event.account !== undefined && event.account !== null)
    throw new Error("connected Stripe event refused");
  if (!Number.isSafeInteger(event.created) || (event.created as number) <= 0)
    throw new Error("service receipt evidence has invalid event time");
  const object = record(record(event.data).object);
  const objectId = identifier(object.id, type === "invoice.paid" ? "in" : "cs");
  requireEqual(object.livemode, false);
  requireEqual(row.event_id, eventId);
  requireEqual(row.type, type);
  requireEqual(row.livemode, 0);
  requireEqual(row.object_id, objectId);
  requireEqual(
    instant(row.event_created_at),
    new Date((event.created as number) * 1000).toISOString(),
  );
  const received = instant(row.received_at);
  const settled = instant(row.settled_at);
  if (settled < received) throw new Error("service receipt settled before receipt");
  requireEqual(row.outcome, outcome);
  requireEqual(row.outcome_detail, detail);
  return object;
}

/** A match describes only supplied records; it cannot authenticate their collection. */
export function verifyServiceReceiptEvidence(raw: string, context: ServiceReceiptContext): true {
  const evidence = record(JSON.parse(raw));
  exact(evidence, [
    "kind",
    "sourceHead",
    "targetSha256",
    "origin",
    "organizationId",
    "workerName",
    "d1DatabaseId",
    "stripeAccountId",
    "subscriptionIntent",
    "subscriptionAssociation",
    "topUpCommand",
    "topUp",
    "invoice",
  ]);
  requireEqual(evidence.kind, "takoserver.hosted-billing-service-receipts@v1");
  requireEqual(evidence.sourceHead, context.input.sourceHead);
  requireEqual(evidence.targetSha256, context.targetSha256);
  requireEqual(evidence.origin, context.origin);
  requireEqual(evidence.organizationId, context.organizationId);
  requireEqual(evidence.workerName, context.workerName);
  requireEqual(evidence.d1DatabaseId, context.d1DatabaseId);
  requireEqual(evidence.stripeAccountId, context.stripeAccountId);

  const intent = record(evidence.subscriptionIntent);
  exact(intent, [
    "id",
    "org_id",
    "request_key_digest",
    "fingerprint",
    "plan_key",
    "pricing_revision",
    "price_id",
    "price_amount_minor",
    "included_minor",
    "livemode",
    "customer_id",
    "state",
    "session_id",
    "subscription_id",
  ]);
  requireEqual(intent.org_id, context.organizationId);
  requireEqual(
    intent.request_key_digest,
    digest([context.organizationId, context.input.subscription.reference]),
  );
  requireEqual(intent.plan_key, context.input.subscription.planKey);
  requireEqual(intent.livemode, 0);
  requireEqual(intent.state, "associated");
  const sessionId = identifier(intent.session_id, "cs");
  const subscriptionId = identifier(intent.subscription_id, "sub");
  const customerId = identifier(intent.customer_id, "cus");
  identifier(intent.price_id, "price");
  if (
    typeof intent.pricing_revision !== "string" ||
    intent.pricing_revision.length === 0 ||
    !Number.isSafeInteger(intent.price_amount_minor) ||
    (intent.price_amount_minor as number) <= 0 ||
    !Number.isSafeInteger(intent.included_minor) ||
    (intent.included_minor as number) < 0
  )
    throw new Error("service receipt evidence has invalid subscription terms");
  requireEqual(
    intent.fingerprint,
    digest([
      context.organizationId,
      context.input.subscription.planKey,
      intent.pricing_revision,
      intent.price_id,
      intent.price_amount_minor,
      intent.included_minor,
      false,
      "subscription",
    ]),
  );
  if (typeof intent.id !== "string" || intent.id.length === 0)
    throw new Error("service receipt evidence has invalid subscription intent");

  const association = record(evidence.subscriptionAssociation);
  exact(association, [
    "subscription_id",
    "org_id",
    "customer_id",
    "livemode",
    "plan_key",
    "pricing_revision",
    "price_id",
    "price_amount_minor",
    "included_minor",
    "session_id",
  ]);
  requireEqual(association.subscription_id, subscriptionId);
  requireEqual(association.org_id, context.organizationId);
  requireEqual(association.livemode, 0);
  requireEqual(association.plan_key, context.input.subscription.planKey);
  for (const [associationField, intentField] of [
    ["customer_id", "customer_id"],
    ["pricing_revision", "pricing_revision"],
    ["price_id", "price_id"],
    ["price_amount_minor", "price_amount_minor"],
    ["included_minor", "included_minor"],
  ] as const)
    requireEqual(association[associationField], intent[intentField]);
  requireEqual(association.session_id, sessionId);
  const subscriptionRef = `sra_${digest(["takoserver-subscription-association-ref:v1", context.organizationId, subscriptionId, customerId, false])}`;
  const command = record(context.subscriptionCommand);
  requireEqual(command.reference, context.input.subscription.reference);
  requireEqual(command.organizationId, context.organizationId);
  requireEqual(command.planKey, context.input.subscription.planKey);
  requireEqual(command.pricingRevision, intent.pricing_revision);
  requireEqual(command.state, "associated");
  requireEqual(command.subscriptionRef, subscriptionRef);
  const publicSubscription = record(context.subscription);
  requireEqual(publicSubscription.organizationId, context.organizationId);
  requireEqual(publicSubscription.subscriptionId, subscriptionId);
  requireEqual(publicSubscription.subscriptionRef, subscriptionRef);
  requireEqual(publicSubscription.planKey, context.input.subscription.planKey);
  requireEqual(publicSubscription.pricingRevision, intent.pricing_revision);

  const topUpCommand = record(evidence.topUpCommand);
  exact(topUpCommand, [
    "org_id",
    "reference",
    "command_json",
    "state",
    "session_id",
    "session_url",
  ]);
  requireEqual(topUpCommand.org_id, context.organizationId);
  requireEqual(topUpCommand.reference, context.input.topup.reference);
  requireEqual(topUpCommand.state, "paid");
  const topUpSessionId = identifier(topUpCommand.session_id, "cs");
  const originalTopUp = record(JSON.parse(String(topUpCommand.command_json)));
  exact(originalTopUp, [
    "customerId",
    "accountId",
    "livemode",
    "financialRealm",
    "pricingRevision",
    "purchaseCreditExpiry",
    "organizationId",
    "reference",
    "amountMinor",
    "amountMicros",
    "currency",
    "purpose",
    "successUrl",
    "cancelUrl",
  ]);
  requireEqual(originalTopUp.organizationId, context.organizationId);
  requireEqual(originalTopUp.reference, context.input.topup.reference);
  requireEqual(originalTopUp.amountMinor, context.input.topup.amountMinor);
  identifier(originalTopUp.customerId, "cus");
  requireEqual(originalTopUp.accountId, context.stripeAccountId);
  requireEqual(originalTopUp.livemode, false);
  requireEqual(originalTopUp.amountMicros, context.input.topup.amountMinor * 10_000);
  requireEqual(originalTopUp.currency, "USD");
  requireEqual(originalTopUp.purpose, "wallet_funding");
  if (typeof originalTopUp.successUrl !== "string" || typeof originalTopUp.cancelUrl !== "string")
    throw new Error("service receipt evidence has invalid top-up return URLs");
  if (
    typeof originalTopUp.financialRealm !== "string" ||
    originalTopUp.financialRealm.length === 0 ||
    typeof originalTopUp.pricingRevision !== "string" ||
    originalTopUp.pricingRevision.length === 0
  )
    throw new Error("service receipt evidence has invalid top-up realm");
  const expiry = record(originalTopUp.purchaseCreditExpiry);
  if (
    expiry.kind !== "none" &&
    (expiry.kind !== "fixed-duration" ||
      !Number.isSafeInteger(expiry.seconds) ||
      (expiry.seconds as number) <= 0)
  )
    throw new Error("service receipt evidence has invalid top-up expiry");
  const topUpReceipt = record(context.topUpReceipt);
  requireEqual(topUpReceipt.reference, context.input.topup.reference);
  requireEqual(topUpReceipt.state, "paid");
  if (!context.topUpAmountProven) throw new Error("top-up original amount acknowledgement absent");
  requireEqual(record(topUpReceipt.checkout).url, topUpCommand.session_url);
  const topUpObject = eventAndReceipt(
    evidence.topUp,
    "checkout.session.completed",
    "credited",
    "credited",
  );
  requireEqual(topUpObject.object, "checkout.session");
  requireEqual(topUpObject.id, topUpSessionId);
  requireEqual(topUpObject.mode, "payment");
  requireEqual(topUpObject.status, "complete");
  requireEqual(topUpObject.payment_status, "paid");
  requireEqual(topUpObject.currency, "usd");
  requireEqual(topUpObject.amount_total, context.input.topup.amountMinor);
  requireEqual(topUpObject.customer, originalTopUp.customerId);
  const topUpMetadata = record(topUpObject.metadata);
  requireEqual(topUpMetadata.organizationId, context.organizationId);
  requireEqual(topUpMetadata.topUpReference, context.input.topup.reference);
  requireEqual(topUpMetadata.stripeAccountId, context.stripeAccountId);
  requireEqual(topUpMetadata.takoserverPurpose, originalTopUp.purpose);
  requireEqual(topUpMetadata.financialRealm, originalTopUp.financialRealm);
  requireEqual(topUpMetadata.pricingRevision, originalTopUp.pricingRevision);
  requireEqual(
    topUpMetadata.purchaseCreditExpiry,
    canonicalJson(originalTopUp.purchaseCreditExpiry),
  );
  requireEqual(topUpMetadata.topUpCommandDigest, `sha256:${digest(originalTopUp)}`);

  const invoice = eventAndReceipt(
    evidence.invoice,
    "invoice.paid",
    "applied",
    "invoice_credit_granted",
  );
  requireEqual(invoice.object, "invoice");
  const invoiceEvent = record(record(evidence.invoice).stripeEvent);
  const snapshot = parseInvoiceSnapshot(invoiceEvent, invoice);
  requireEqual(snapshot.subscriptionId, subscriptionId);
  requireEqual(snapshot.customerId, customerId);
  const pinned = snapshot.metadata;
  requireEqual(pinned.takoserverPurpose, "hosted_subscription");
  requireEqual(pinned.organizationId, context.organizationId);
  requireEqual(pinned.planKey, context.input.subscription.planKey);
  requireEqual(pinned.pricingRevision, intent.pricing_revision);
  if (snapshot.modern) requireEqual(pinned.subscriptionCheckoutIntentId, intent.id);
  return true;
}
