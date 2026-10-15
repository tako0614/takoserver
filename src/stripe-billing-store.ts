import { stripeRefundSource } from "./ledger.ts";
import type { Clock, Row, Sql, SqlStatement } from "./ports.ts";
import type { StripeOnDemandFundingProof } from "./stripe-on-demand-verification.ts";

export interface BillingGrant {
  readonly organizationId: string;
  readonly fundingRef: string;
  readonly kind: "purchased" | "plan-included";
  readonly amountMicros: number;
  readonly expiresAt: string | null;
  readonly sourceType: "checkout" | "invoice" | "payment-intent";
  readonly sourceId: string;
  readonly chargeId: string;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly planKey: string | null;
  readonly pricingRevision: string | null;
  readonly stripePriceId: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly considerationMicros: number;
}

export interface RefundReceipt {
  readonly refundId: string;
  readonly organizationId: string;
  readonly fundingRef: string;
  readonly amountMicros: number;
  readonly cumulativeRefundedMicros: number;
  readonly targetRevokedMicros: number;
  readonly debitMicros: number;
  readonly receivableMicros: number;
  readonly expiredMicros: number;
  readonly createdAt: string;
}

export class StripeBillingStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StripeBillingStoreError";
  }
}

function fail(code: string): never {
  throw new StripeBillingStoreError(code);
}

function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_amount");
}

function optionalTime(value: string | null): void {
  if (
    value !== null &&
    (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
  )
    fail("invalid_time");
}

function grantFrom(row: Row): BillingGrant {
  return {
    organizationId: String(row.org_id),
    fundingRef: String(row.funding_ref),
    kind: row.kind as BillingGrant["kind"],
    amountMicros: Number(row.amount_micros),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    sourceType: row.source_type as BillingGrant["sourceType"],
    sourceId: String(row.source_id),
    chargeId: String(row.charge_id),
    customerId: row.customer_id == null ? null : String(row.customer_id),
    subscriptionId: row.subscription_id == null ? null : String(row.subscription_id),
    planKey: row.plan_key == null ? null : String(row.plan_key),
    pricingRevision: row.pricing_revision == null ? null : String(row.pricing_revision),
    stripePriceId: row.stripe_price_id == null ? null : String(row.stripe_price_id),
    periodStart: row.period_start == null ? null : String(row.period_start),
    periodEnd: row.period_end == null ? null : String(row.period_end),
    considerationMicros: Number(row.consideration_micros),
  };
}

function receiptFrom(row: Row): RefundReceipt {
  return {
    refundId: String(row.refund_id),
    organizationId: String(row.org_id),
    fundingRef: String(row.funding_ref),
    amountMicros: Number(row.amount_micros),
    cumulativeRefundedMicros: Number(row.cumulative_refunded_micros),
    targetRevokedMicros: Number(row.target_revoked_micros),
    debitMicros: Number(row.debit_micros),
    receivableMicros: Number(row.receivable_micros),
    expiredMicros: Number(row.expired_micros),
    createdAt: String(row.created_at),
  };
}

function sameGrant(a: BillingGrant, b: BillingGrant): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.fundingRef === b.fundingRef &&
    a.kind === b.kind &&
    a.amountMicros === b.amountMicros &&
    a.expiresAt === b.expiresAt &&
    a.sourceType === b.sourceType &&
    a.sourceId === b.sourceId &&
    a.chargeId === b.chargeId &&
    a.customerId === b.customerId &&
    a.subscriptionId === b.subscriptionId &&
    a.planKey === b.planKey &&
    a.pricingRevision === b.pricingRevision &&
    a.stripePriceId === b.stripePriceId &&
    a.periodStart === b.periodStart &&
    a.periodEnd === b.periodEnd &&
    a.considerationMicros === b.considerationMicros
  );
}

function guard(
  id: string,
  condition: string,
  params: readonly (string | number | null)[] = [],
): SqlStatement {
  return {
    sql: `INSERT INTO wallet_allocation_guards (id, valid) VALUES (?, CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
    params: [id, ...params],
  };
}

function lotStatements(input: BillingGrant, now: string): SqlStatement[] {
  return [
    {
      sql: `INSERT INTO wallet_credit_lots (org_id, ref, kind, consumption_class, amount_micros, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.organizationId,
        input.fundingRef,
        input.kind,
        input.kind === "purchased" ? "purchased" : "subscription",
        input.amountMicros,
        input.expiresAt,
        now,
      ],
    },
    {
      sql: `INSERT INTO ledger (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at)
      VALUES (?, ?, 'funding', ?, ?, 0, ?)`,
      params: [
        `led_${crypto.randomUUID()}`,
        input.organizationId,
        input.fundingRef,
        input.amountMicros,
        now,
      ],
    },
  ];
}

function conservationStatement(
  id: string,
  input: BillingGrant,
  now: string,
  refunds: "stripe_billing_refunds" | "stripe_billing_refund_receipts_all",
): SqlStatement {
  return guard(
    id,
    `EXISTS (SELECT 1 FROM wallet_credit_lots l JOIN ledger e
              ON e.org_id = l.org_id AND e.ref = l.ref AND e.type = 'funding'
              WHERE l.org_id = ? AND l.ref = ? AND l.kind = ?
                AND l.consumption_class = ? AND l.amount_micros = ? AND l.expires_at IS ?
                AND e.settled_delta_micros = ? AND e.held_delta_micros = 0)
             AND (SELECT COALESCE(SUM(held_delta_micros), 0) FROM ledger WHERE org_id = ?)
                 = (SELECT COALESCE(SUM(amount_micros), 0) FROM wallet_credit_allocations
                    WHERE org_id = ? AND debit_type = 'hold')
             AND (SELECT COALESCE(SUM(held_delta_micros), 0) FROM ledger WHERE org_id = ?)
                 BETWEEN 0 AND 9007199254740991
             AND (SELECT COALESCE(SUM(CASE
                 WHEN l.expires_at IS NULL OR l.expires_at > ? THEN
                   l.amount_micros - COALESCE((SELECT SUM(a.amount_micros)
                     FROM wallet_credit_allocations a WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
                       AND a.debit_type IN ('capture', 'usage_debit')), 0)
                   - COALESCE((SELECT SUM(r.debit_micros) FROM ${refunds} r
                     WHERE r.org_id = l.org_id AND r.funding_ref = l.ref), 0)
                 ELSE COALESCE((SELECT SUM(a.amount_micros)
                   FROM wallet_credit_allocations a WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
                     AND a.debit_type = 'hold'), 0) END), 0)
               FROM wallet_credit_lots l WHERE l.org_id = ?)
                 BETWEEN (SELECT COALESCE(SUM(held_delta_micros), 0) FROM ledger WHERE org_id = ?)
                     AND 9007199254740991`,
    [
      input.organizationId,
      input.fundingRef,
      input.kind,
      input.kind === "purchased" ? "purchased" : "subscription",
      input.amountMicros,
      input.expiresAt,
      input.amountMicros,
      input.organizationId,
      input.organizationId,
      input.organizationId,
      now,
      input.organizationId,
      input.organizationId,
    ],
  );
}

const onDemandProjection = `SELECT f.org_id, f.funding_ref, 'purchased' AS kind,
  f.amount_micros, f.expires_at, 'payment-intent' AS source_type,
  f.payment_intent_id AS source_id, f.charge_id, c.customer_id,
  NULL AS subscription_id, NULL AS plan_key, NULL AS pricing_revision,
  NULL AS stripe_price_id, NULL AS period_start, NULL AS period_end,
  f.amount_micros AS consideration_micros
  FROM stripe_billing_on_demand_funding f
  JOIN stripe_billing_on_demand_commands c ON c.org_id=f.org_id AND c.reference=f.reference`;

function refundFloorParams(organizationId: string, fundingRef: string): string[] {
  return [
    organizationId,
    fundingRef,
    organizationId,
    fundingRef,
    organizationId,
    fundingRef,
    organizationId,
    fundingRef,
  ];
}

// The generic dispatched readback lane accepts arbitrary JSON. A tag alone is
// never a qualified original-source observation. Check its complete closed
// proof and time/ownership contract before using it, including before funding.
const observationRows = `FROM stripe_billing_on_demand_attempts a
  JOIN stripe_billing_on_demand_commands c ON c.org_id=a.org_id AND c.reference=a.reference
  LEFT JOIN stripe_billing_on_demand_funding f ON f.org_id=c.org_id AND f.reference=c.reference
  LEFT JOIN stripe_billing_on_demand_terminals t ON t.org_id=c.org_id AND t.reference=c.reference
  LEFT JOIN org_wallet_cash_exposures e ON e.org_id=c.org_id AND e.ref=c.exposure_ref`;
const taggedObservation = `json_extract(a.detail_json,'$.kind')='native-refund-observation-v1'`;
const qualifiedObservation = `(a.kind='readback' AND c.state IN ('dispatched','paid')
  AND c.dispatched_at IS NOT NULL AND c.dispatched_at<=a.created_at
  AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_abandonments b WHERE b.org_id=c.org_id AND b.reference=c.reference)
  AND EXISTS (SELECT 1 FROM stripe_billing_account_realms r JOIN stripe_mode_realm m ON m.singleton=r.singleton
    WHERE r.singleton=1 AND r.account_id=c.account_id AND r.mode='test' AND m.mode=r.mode AND r.mode=c.mode AND r.billing_authority=c.billing_authority)
  AND (c.payment_intent_id IS NULL OR json_extract(a.detail_json,'$.proof.paymentIntentId') IS c.payment_intent_id)
  AND length(json_extract(a.detail_json,'$.proof.paymentIntentId')) BETWEEN 4 AND 255
  AND substr(json_extract(a.detail_json,'$.proof.paymentIntentId'),1,3)='pi_'
  AND substr(json_extract(a.detail_json,'$.proof.paymentIntentId'),4) NOT GLOB '*[^A-Za-z0-9_]*'
  AND length(json_extract(a.detail_json,'$.proof.chargeId')) BETWEEN 4 AND 255
  AND substr(json_extract(a.detail_json,'$.proof.chargeId'),1,3)='ch_'
  AND substr(json_extract(a.detail_json,'$.proof.chargeId'),4) NOT GLOB '*[^A-Za-z0-9_]*'
  AND length(json_extract(a.detail_json,'$.proof.observedAt'))=24
  AND json_extract(a.detail_json,'$.proof.observedAt')<='9999-12-31T23:59:59.000Z'
  AND (SELECT count(*) FROM json_each(c.request_json,'$.metadata'))=7
  AND ((f.org_id IS NULL AND c.state='dispatched'
      AND e.status='reserved' AND e.source_ref IS NULL AND e.amount_minor=c.amount_minor
      AND e.period_start IS c.period_start AND e.period_end IS c.period_end
      AND e.policy_version IS c.policy_version AND e.consent_revision IS c.consent_revision
      AND (t.org_id IS NULL OR (t.status='succeeded'
        AND t.payment_intent_id IS json_extract(a.detail_json,'$.proof.paymentIntentId') AND t.charge_id IS json_extract(a.detail_json,'$.proof.chargeId')
        AND t.exposure_ref IS c.exposure_ref AND t.account_id IS c.account_id AND t.mode IS c.mode
        AND t.billing_authority IS c.billing_authority AND t.customer_id IS c.customer_id
        AND t.payment_method_id IS c.payment_method_id AND t.currency='usd' AND t.amount_minor=c.amount_minor)))
    OR (c.state='paid' AND f.org_id IS c.org_id AND f.command_state='paid' AND f.cap_state='paid'
      AND f.funding_ref IS c.funding_ref AND f.exposure_ref IS c.exposure_ref
      AND f.payment_intent_id IS c.payment_intent_id AND f.amount_micros=c.amount_minor*10000
      AND t.status='succeeded' AND t.payment_intent_id IS f.payment_intent_id AND t.charge_id IS f.charge_id
      AND t.exposure_ref IS c.exposure_ref AND t.account_id IS c.account_id AND t.mode IS c.mode
      AND t.billing_authority IS c.billing_authority AND t.customer_id IS c.customer_id
      AND t.payment_method_id IS c.payment_method_id AND t.currency='usd' AND t.amount_minor=c.amount_minor
      AND e.status='paid' AND e.source_ref IS f.payment_intent_id AND e.amount_minor=c.amount_minor
      AND e.period_start IS c.period_start AND e.period_end IS c.period_end
      AND e.policy_version IS c.policy_version AND e.consent_revision IS c.consent_revision))
    AND json_type(a.detail_json,'$.kind') IS 'text'
    AND json_extract(a.detail_json,'$.kind') IS 'native-refund-observation-v1'
    AND json_type(a.detail_json,'$.proof') IS 'object'
    AND (SELECT count(*) FROM json_each(a.detail_json))=2
    AND NOT EXISTS (SELECT 1 FROM json_each(a.detail_json) WHERE key NOT IN ('kind','proof'))
    AND (SELECT count(*) FROM json_each(a.detail_json,'$.proof'))=18
    AND NOT EXISTS (SELECT 1 FROM json_each(a.detail_json,'$.proof')
      WHERE key NOT IN ('kind','sourceType','organizationId','reference','fingerprint','fundingRef','accountId','mode','financialRealm','billingAuthority','customerId','paymentMethodId','paymentIntentId','chargeId','currency','amountMinor','refundedAmountMinor','observedAt')
        OR (key NOT IN ('amountMinor','refundedAmountMinor') AND type<>'text'))
    AND json_extract(a.detail_json,'$.proof.kind') IS 'stripe-on-demand-funding'
    AND json_extract(a.detail_json,'$.proof.sourceType') IS 'payment-intent'
    AND json_extract(a.detail_json,'$.proof.organizationId') IS c.org_id
    AND json_extract(a.detail_json,'$.proof.reference') IS c.reference
    AND json_extract(a.detail_json,'$.proof.fingerprint') IS c.fingerprint
    AND json_extract(a.detail_json,'$.proof.fundingRef') IS c.funding_ref
    AND json_extract(a.detail_json,'$.proof.accountId') IS c.account_id
    AND json_extract(a.detail_json,'$.proof.mode') IS 'test' AND c.mode='test'
    AND json_extract(a.detail_json,'$.proof.billingAuthority') IS c.billing_authority
    AND json_extract(a.detail_json,'$.proof.customerId') IS c.customer_id
    AND json_extract(a.detail_json,'$.proof.paymentMethodId') IS c.payment_method_id
    AND (f.payment_intent_id IS NULL OR json_extract(a.detail_json,'$.proof.paymentIntentId') IS f.payment_intent_id)
    AND (f.charge_id IS NULL OR json_extract(a.detail_json,'$.proof.chargeId') IS f.charge_id)
    AND json_extract(a.detail_json,'$.proof.currency') IS 'USD'
    AND json_type(a.detail_json,'$.proof.amountMinor') IS 'integer'
    AND json_extract(a.detail_json,'$.proof.amountMinor') IS c.amount_minor
    AND json_type(a.detail_json,'$.proof.refundedAmountMinor') IS 'integer'
    AND json_extract(a.detail_json,'$.proof.refundedAmountMinor') BETWEEN 0 AND c.amount_minor
    AND json_type(a.detail_json,'$.proof.observedAt') IS 'text'
    AND strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(a.detail_json,'$.proof.observedAt')) IS json_extract(a.detail_json,'$.proof.observedAt')
    AND json_extract(a.detail_json,'$.proof.observedAt')>=c.dispatched_at
    AND json_extract(a.detail_json,'$.proof.observedAt')<=a.created_at
    AND json_type(c.request_json,'$.metadata') IS 'object'
    AND json_extract(c.request_json,'$.currency') IS 'usd'
    AND json_extract(c.request_json,'$.metadata.organizationId') IS c.org_id
    AND json_extract(c.request_json,'$.metadata.reference') IS c.reference
    AND json_extract(c.request_json,'$.metadata.fingerprint') IS c.fingerprint
    AND json_extract(c.request_json,'$.metadata.fundingRef') IS c.funding_ref
    AND json_extract(c.request_json,'$.metadata.stripeAccountId') IS c.account_id
    AND json_extract(c.request_json,'$.metadata.billingAuthority') IS c.billing_authority
    AND json_type(c.request_json,'$.metadata.financialRealm') IS 'text'
    AND length(json_extract(c.request_json,'$.metadata.financialRealm'))=70
    AND substr(json_extract(c.request_json,'$.metadata.financialRealm'),1,6)='realm:'
    AND substr(json_extract(c.request_json,'$.metadata.financialRealm'),7) NOT GLOB '*[^a-f0-9]*'
    AND json_extract(a.detail_json,'$.proof.financialRealm') IS json_extract(c.request_json,'$.metadata.financialRealm'))`;

// An invalid tagged row is not silently skipped or used as a native MAX. The
// unsafe sentinel fails every checked read and every atomic release guard.
const onDemandRefundFloor = `CASE WHEN EXISTS (SELECT 1 ${observationRows}
  WHERE c.org_id=? AND c.funding_ref=? AND ${taggedObservation} AND NOT ${qualifiedObservation})
  THEN 9007199254740992 ELSE COALESCE((SELECT MAX(amount) FROM (
  SELECT json_extract(t.native_receipt_json, '$.refundedAmountMinor') * 10000 AS amount
    FROM stripe_billing_on_demand_funding f
    JOIN stripe_billing_on_demand_terminals t ON t.org_id=f.org_id AND t.reference=f.reference
    WHERE f.org_id = ? AND f.funding_ref = ?
  UNION ALL
  SELECT json_extract(native_receipt_json, '$.refundedAmountMinor') * 10000
    FROM stripe_billing_on_demand_refunds WHERE org_id = ? AND funding_ref = ?
  UNION ALL
  SELECT json_extract(a.detail_json,'$.proof.refundedAmountMinor') * 10000 ${observationRows}
    WHERE c.org_id=? AND c.funding_ref=? AND ${taggedObservation} AND ${qualifiedObservation}
)), 0) END`;

function checkedRefundFloor(value: unknown): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) fail("invalid_refund_observation");
  return amount;
}

function fundingFenceStatement(
  organizationId: string,
  fundingRef: string,
  now: string,
  observationMicros?: number,
): SqlStatement {
  return {
    sql: `INSERT INTO stripe_billing_fences (org_id,funding_ref,generation,active,updated_at)
      SELECT ?,?,1,1,? WHERE ${observationMicros === undefined ? "1" : `? > (SELECT COALESCE(SUM(amount_micros),0) FROM stripe_billing_refund_receipts_all WHERE org_id=? AND funding_ref=?)`}
      ON CONFLICT (org_id,funding_ref) DO UPDATE SET
        generation = generation + ${observationMicros === undefined ? "1" : "CASE WHEN active = 1 THEN 0 ELSE 1 END"},
        active = 1, updated_at = excluded.updated_at
      RETURNING generation`,
    params: [
      organizationId,
      fundingRef,
      now,
      ...(observationMicros === undefined ? [] : [observationMicros, organizationId, fundingRef]),
    ],
  };
}

function observationIdentityConflict(): string {
  return `EXISTS (SELECT 1 FROM stripe_billing_on_demand_attempts a
    JOIN stripe_billing_on_demand_commands c ON c.org_id=a.org_id AND c.reference=a.reference
    WHERE c.org_id=? AND c.funding_ref=? AND ${taggedObservation}
      AND (json_extract(a.detail_json,'$.proof.paymentIntentId') IS NOT ? OR json_extract(a.detail_json,'$.proof.chargeId') IS NOT ?))`;
}

// This store consumes an authenticated owner's sanitized proof; it does not
// turn a native JSON body or a structural type into processor authority.
function sanitizedFundingProof(input: StripeOnDemandFundingProof): StripeOnDemandFundingProof {
  // Deliberately enumerate and capture the persisted fields once. Extra native
  // details, metadata, card data and client secrets never enter receipt JSON.
  const proof = Object.freeze({
    kind: input.kind,
    sourceType: input.sourceType,
    organizationId: input.organizationId,
    reference: input.reference,
    fingerprint: input.fingerprint,
    fundingRef: input.fundingRef,
    accountId: input.accountId,
    mode: input.mode,
    financialRealm: input.financialRealm,
    billingAuthority: input.billingAuthority,
    customerId: input.customerId,
    paymentMethodId: input.paymentMethodId,
    paymentIntentId: input.paymentIntentId,
    chargeId: input.chargeId,
    currency: input.currency,
    amountMinor: input.amountMinor,
    refundedAmountMinor: input.refundedAmountMinor,
    observedAt: input.observedAt,
  });
  if (
    proof.kind !== "stripe-on-demand-funding" ||
    proof.sourceType !== "payment-intent" ||
    ![
      proof.organizationId,
      proof.reference,
      proof.fingerprint,
      proof.fundingRef,
      proof.financialRealm,
      proof.billingAuthority,
    ].every((value) => typeof value === "string" && value.length > 0 && value.length <= 512) ||
    !/^acct_[A-Za-z0-9]+$/.test(proof.accountId) ||
    proof.mode !== "test" ||
    !proof.financialRealm ||
    !proof.billingAuthority ||
    !/^cus_[A-Za-z0-9_]+$/.test(proof.customerId) ||
    !/^pm_[A-Za-z0-9_]+$/.test(proof.paymentMethodId) ||
    !/^pi_[A-Za-z0-9_]+$/.test(proof.paymentIntentId) ||
    !/^ch_[A-Za-z0-9_]+$/.test(proof.chargeId) ||
    proof.currency !== "USD" ||
    !Number.isSafeInteger(proof.amountMinor) ||
    proof.amountMinor < 1 ||
    proof.amountMinor > 900719925474 ||
    !Number.isSafeInteger(proof.refundedAmountMinor) ||
    proof.refundedAmountMinor < 0 ||
    proof.refundedAmountMinor > proof.amountMinor
  )
    fail("invalid_native_proof");
  optionalTime(proof.observedAt);
  if (
    typeof proof.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(proof.observedAt) ||
    proof.observedAt > "9999-12-31T23:59:59.000Z"
  )
    fail("invalid_native_proof");
  return proof;
}

function matchesOnDemandCommand(command: Row, proof: StripeOnDemandFundingProof): boolean {
  let request: { metadata?: Record<string, unknown> };
  try {
    request = JSON.parse(String(command.request_json));
  } catch {
    return false;
  }
  const metadata = request && typeof request === "object" ? request.metadata : undefined;
  return (
    command.org_id === proof.organizationId &&
    command.reference === proof.reference &&
    command.fingerprint === proof.fingerprint &&
    command.funding_ref === proof.fundingRef &&
    command.account_id === proof.accountId &&
    command.mode === proof.mode &&
    command.billing_authority === proof.billingAuthority &&
    command.customer_id === proof.customerId &&
    command.payment_method_id === proof.paymentMethodId &&
    Number(command.amount_minor) === proof.amountMinor &&
    (command.payment_intent_id == null || command.payment_intent_id === proof.paymentIntentId) &&
    metadata !== undefined &&
    Object.keys(metadata).length === 7 &&
    metadata.organizationId === proof.organizationId &&
    metadata.reference === proof.reference &&
    metadata.fingerprint === proof.fingerprint &&
    metadata.stripeAccountId === proof.accountId &&
    metadata.financialRealm === proof.financialRealm &&
    metadata.billingAuthority === proof.billingAuthority &&
    metadata.fundingRef === proof.fundingRef
  );
}

function firstFundingExpiry(command: Row, now: string): string | null {
  optionalTime(now);
  const start = Date.parse(now);
  if (!Number.isSafeInteger(start) || now > "9999-12-31T23:59:59.000Z") fail("invalid_time");
  if (command.credit_expiry_kind === "none" && command.credit_expiry_seconds === null) return null;
  const duration = Number(command.credit_expiry_seconds);
  if (
    command.credit_expiry_kind !== "fixed-duration" ||
    !Number.isSafeInteger(duration) ||
    duration < 1 ||
    duration > Math.floor((253402300799000 - start) / 1000)
  )
    fail("invalid_expiry");
  return new Date(start + duration * 1000).toISOString();
}

const storeOrigins = new WeakMap<object, { readonly sql: Sql; readonly clock: Clock }>();

export type StripeBillingStore = ReturnType<typeof createStripeBillingStore>;

export function assertStripeBillingStoreOrigin(
  value: unknown,
  expected: { readonly sql: Sql; readonly clock: Clock },
): asserts value is StripeBillingStore {
  const origin = value !== null && typeof value === "object" ? storeOrigins.get(value) : undefined;
  if (!origin || origin.sql !== expected.sql || origin.clock !== expected.clock)
    fail("invalid_store_origin");
}

export function createStripeBillingStore(options: { readonly sql: Sql; readonly clock: Clock }) {
  const { sql, clock } = options;
  const at = () => clock().toISOString();
  const extendedSchema = async (): Promise<boolean> => {
    const names = [
      "stripe_billing_on_demand_commands",
      "stripe_billing_on_demand_attempts",
      "stripe_billing_on_demand_terminals",
      "stripe_billing_on_demand_funding",
      "stripe_billing_on_demand_refunds",
      "stripe_billing_funding_sources_all",
      "stripe_billing_refund_receipts_all",
    ];
    const rows = await sql.query(
      `SELECT name, type FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(",")})`,
      names,
    );
    if (rows.length === 0) return false;
    if (
      rows.length !== names.length ||
      rows.some((row) => row.type !== (String(row.name).endsWith("_all") ? "view" : "table"))
    )
      fail("on_demand_schema_unavailable");
    // Assert the consumed projection columns before selecting new-source money.
    await sql.query(`${onDemandProjection} LIMIT 0`);
    if ((await stripeRefundSource(sql)) !== "stripe_billing_refund_receipts_all")
      fail("on_demand_schema_unavailable");
    await sql.query(`SELECT refund_id, org_id, funding_ref, amount_micros,
      cumulative_refunded_micros, target_revoked_micros, debit_micros,
      receivable_micros, expired_micros, created_at FROM stripe_billing_refund_receipts_all LIMIT 0`);
    return true;
  };
  const refundProjection = async () => {
    const projection = await stripeRefundSource(sql);
    if (!projection) fail("on_demand_schema_unavailable");
    return projection;
  };
  const source = async (type: BillingGrant["sourceType"], id: string) => {
    if (type === "payment-intent") {
      if (!(await extendedSchema())) fail("on_demand_schema_unavailable");
      const rows = await sql.query(`${onDemandProjection} WHERE f.payment_intent_id = ?`, [id]);
      return rows[0] ? grantFrom(rows[0]) : null;
    }
    const rows = await sql.query(
      "SELECT * FROM stripe_billing_grants WHERE source_type = ? AND source_id = ?",
      [type, id],
    );
    return rows[0] ? grantFrom(rows[0]) : null;
  };
  const receipt = async (id: string) => {
    const projection = await refundProjection();
    const rows = await sql.query(`SELECT * FROM ${projection} WHERE refund_id = ?`, [id]);
    if (rows.length > 1) fail("refund_conflict");
    return rows[0] ? receiptFrom(rows[0]) : null;
  };

  const refundState = async (
    organizationId: string,
    fundingRef: string,
    proof?: StripeOnDemandFundingProof,
  ) => {
    const rows = await sql.query(
      `SELECT ${onDemandRefundFloor} AS amount,
      (SELECT active FROM stripe_billing_fences WHERE org_id=? AND funding_ref=?) AS active,
      (SELECT COALESCE(SUM(amount_micros),0) FROM stripe_billing_refund_receipts_all WHERE org_id=? AND funding_ref=?) AS refunded
      ${proof ? `, ${observationIdentityConflict()} AS conflict` : ""}`,
      [
        ...refundFloorParams(organizationId, fundingRef),
        organizationId,
        fundingRef,
        organizationId,
        fundingRef,
        ...(proof ? [organizationId, fundingRef, proof.paymentIntentId, proof.chargeId] : []),
      ],
    );
    const state = rows[0];
    const amount = checkedRefundFloor(state?.amount ?? 0);
    if (proof && Number(state?.conflict) !== 0) fail("grant_conflict");
    return { amount, active: state?.active === 1, refunded: Number(state?.refunded ?? 0) };
  };
  const observeNativeRefund = async (proof: StripeOnDemandFundingProof): Promise<void> => {
    const org = proof.organizationId;
    const ref = proof.fundingRef;
    const amount = proof.refundedAmountMinor * 10000;
    const previous = await refundState(org, ref, proof);
    if (amount <= previous.amount && (previous.active || previous.amount <= previous.refunded))
      return;
    const now = at();
    if (now < proof.observedAt) fail("invalid_time");
    const fence = fundingFenceStatement(org, ref, now, Math.max(amount, previous.amount));
    const detail = JSON.stringify({ kind: "native-refund-observation-v1", proof });
    try {
      await sql.batch([
        fence,
        {
          sql: `INSERT INTO stripe_billing_on_demand_attempts
          (org_id,reference,sequence,kind,detail_json,created_at,first_dispatch_at)
          SELECT c.org_id,c.reference,
            (SELECT COALESCE(MAX(a.sequence),0)+1 FROM stripe_billing_on_demand_attempts a WHERE a.org_id=c.org_id AND a.reference=c.reference),
            'readback',?,?,NULL FROM stripe_billing_on_demand_commands c
          WHERE c.org_id=? AND c.reference=? AND c.state='paid' AND ? > ${onDemandRefundFloor}`,
          params: [detail, now, org, proof.reference, amount, ...refundFloorParams(org, ref)],
        },
      ]);
    } catch (error) {
      const committed = await refundState(org, ref, proof);
      if (
        committed.amount >= amount &&
        (committed.active || committed.refunded >= committed.amount)
      )
        return;
      throw error;
    }
    const committed = await refundState(org, ref, proof);
    if (committed.amount < amount || (!committed.active && committed.refunded < committed.amount))
      fail("refund_observation_unavailable");
  };

  const store = {
    grantForSource: source,
    async grantsForCharge(chargeId: string): Promise<readonly BillingGrant[]> {
      const old = (
        await sql.query("SELECT * FROM stripe_billing_grants WHERE charge_id = ?", [chargeId])
      ).map(grantFrom);
      const added = (await extendedSchema())
        ? (await sql.query(`${onDemandProjection} WHERE f.charge_id = ?`, [chargeId])).map(
            grantFrom,
          )
        : [];
      return [...old, ...added].sort((a, b) => {
        const left = a.sourceType === b.sourceType ? a.sourceId : a.sourceType;
        const right = a.sourceType === b.sourceType ? b.sourceId : b.sourceType;
        return left < right ? -1 : left > right ? 1 : 0;
      });
    },
    async grantForCharge(chargeId: string): Promise<BillingGrant | null> {
      const rows = await this.grantsForCharge(chargeId);
      if (rows.length > 1) fail("ambiguous_charge");
      return rows[0] ?? null;
    },
    async grant(input: BillingGrant): Promise<void> {
      if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros < 0)
        fail("invalid_amount");
      positive(input.considerationMicros);
      if (input.kind === "purchased" && input.amountMicros !== input.considerationMicros)
        fail("invalid_purchase_consideration");
      if (
        !input.organizationId ||
        !input.fundingRef ||
        !input.sourceId ||
        !input.chargeId ||
        (input.kind === "purchased" && input.sourceType !== "checkout") ||
        (input.kind === "plan-included" && input.sourceType !== "invoice") ||
        (input.sourceType === "invoice" &&
          (!input.subscriptionId ||
            !input.planKey ||
            !input.pricingRevision ||
            !input.stripePriceId ||
            !input.periodStart ||
            !input.periodEnd ||
            input.periodStart >= input.periodEnd))
      )
        fail("invalid_grant");
      for (const value of [input.expiresAt, input.periodStart, input.periodEnd])
        optionalTime(value);
      const existing = await source(input.sourceType, input.sourceId);
      if (existing) {
        if (!sameGrant(existing, input)) fail("grant_conflict");
        return;
      }
      const now = at();
      if (input.sourceType === "invoice" && input.periodStart !== null && input.periodStart > now)
        fail("invoice_period_not_started");
      const oldLot = (
        await sql.query(
          "SELECT kind, consumption_class, amount_micros, expires_at FROM wallet_credit_lots WHERE org_id = ? AND ref = ?",
          [input.organizationId, input.fundingRef],
        )
      )[0];
      const legacyLot =
        oldLot !== undefined &&
        input.kind === "purchased" &&
        input.sourceType === "checkout" &&
        input.fundingRef === `stripe:${input.sourceId}` &&
        input.expiresAt === null &&
        oldLot.kind === "direct" &&
        oldLot.consumption_class === "purchased" &&
        Number(oldLot.amount_micros) === input.amountMicros &&
        oldLot.expires_at === null;
      if (oldLot && !legacyLot) fail("grant_conflict");
      const refunds = await refundProjection();
      const legacyGuard = `guard_${crypto.randomUUID()}`;
      const moneyGuard = `guard_${crypto.randomUUID()}`;
      const periodGuard = `guard_${crypto.randomUUID()}`;
      try {
        await sql.batch([
          ...(legacyLot
            ? [
                guard(
                  legacyGuard,
                  `EXISTS (SELECT 1 FROM wallet_credit_lots l JOIN ledger e
              ON e.org_id = l.org_id AND e.ref = l.ref AND e.type = 'funding'
              WHERE l.org_id = ? AND l.ref = ? AND l.kind = 'direct'
                AND l.consumption_class = 'purchased'
                AND l.amount_micros = ? AND l.expires_at IS NULL
                AND e.settled_delta_micros = ? AND e.held_delta_micros = 0)
              AND NOT EXISTS (SELECT 1 FROM stripe_billing_grants
                WHERE org_id = ? AND funding_ref = ?)`,
                  [
                    input.organizationId,
                    input.fundingRef,
                    input.amountMicros,
                    input.amountMicros,
                    input.organizationId,
                    input.fundingRef,
                  ],
                ),
              ]
            : []),
          ...(input.amountMicros > 0 && !legacyLot ? lotStatements(input, now) : []),
          {
            sql: `INSERT INTO stripe_billing_grants
              (org_id, funding_ref, kind, consumption_class, amount_micros, expires_at, source_type, source_id, charge_id,
               customer_id, subscription_id, plan_key, pricing_revision, stripe_price_id,
               period_start, period_end, consideration_micros, legacy_lot, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              input.organizationId,
              input.fundingRef,
              input.kind,
              input.kind === "purchased" ? "purchased" : "subscription",
              input.amountMicros,
              input.expiresAt,
              input.sourceType,
              input.sourceId,
              input.chargeId,
              input.customerId,
              input.subscriptionId,
              input.planKey,
              input.pricingRevision,
              input.stripePriceId,
              input.periodStart,
              input.periodEnd,
              input.considerationMicros,
              legacyLot ? 1 : 0,
              now,
            ],
          },
          ...(input.sourceType === "invoice"
            ? [
                guard(
                  periodGuard,
                  `EXISTS (SELECT 1 FROM stripe_billing_grants
                 WHERE org_id = ? AND funding_ref = ? AND source_type = 'invoice'
                   AND period_start <= created_at)`,
                  [input.organizationId, input.fundingRef],
                ),
              ]
            : []),
          ...(input.amountMicros > 0 && !legacyLot
            ? [conservationStatement(moneyGuard, input, now, refunds)]
            : []),
          ...(legacyLot
            ? [
                {
                  sql: "DELETE FROM wallet_allocation_guards WHERE id = ?",
                  params: [legacyGuard],
                },
              ]
            : []),
          ...(input.amountMicros > 0 && !legacyLot
            ? [
                {
                  sql: "DELETE FROM wallet_allocation_guards WHERE id = ?",
                  params: [moneyGuard],
                },
              ]
            : []),
          ...(input.sourceType === "invoice"
            ? [{ sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [periodGuard] }]
            : []),
        ]);
      } catch (error) {
        const committed = await source(input.sourceType, input.sourceId);
        if (committed && sameGrant(committed, input)) return;
        throw error;
      }
    },
    async grantOnDemand(input: {
      readonly organizationId: string;
      readonly reference: string;
      readonly expectedCommandFingerprint: string;
      readonly native: StripeOnDemandFundingProof;
    }): Promise<BillingGrant> {
      if (!(await extendedSchema())) fail("on_demand_schema_unavailable");
      const proof = sanitizedFundingProof(input.native);
      if (
        proof.organizationId !== input.organizationId ||
        proof.reference !== input.reference ||
        proof.fingerprint !== input.expectedCommandFingerprint
      )
        fail("grant_conflict");
      const command = (
        await sql.query(
          "SELECT * FROM stripe_billing_on_demand_commands WHERE org_id = ? AND reference = ?",
          [input.organizationId, input.reference],
        )
      )[0];
      if (!command || !matchesOnDemandCommand(command, proof)) fail("grant_conflict");
      await refundState(proof.organizationId, proof.fundingRef, proof);
      const existing = await source("payment-intent", proof.paymentIntentId);
      if (existing) {
        if (
          existing.organizationId !== proof.organizationId ||
          existing.fundingRef !== proof.fundingRef ||
          existing.chargeId !== proof.chargeId ||
          existing.customerId !== proof.customerId ||
          existing.amountMicros !== proof.amountMinor * 10000
        )
          fail("grant_conflict");
        await observeNativeRefund(proof);
        return existing;
      }
      if (command.state !== "dispatched") fail("grant_conflict");
      const now = at();
      if (now < proof.observedAt) fail("invalid_time");
      const grant: BillingGrant = {
        organizationId: proof.organizationId,
        fundingRef: proof.fundingRef,
        kind: "purchased",
        amountMicros: proof.amountMinor * 10000,
        expiresAt: firstFundingExpiry(command, now),
        sourceType: "payment-intent",
        sourceId: proof.paymentIntentId,
        chargeId: proof.chargeId,
        customerId: proof.customerId,
        subscriptionId: null,
        planKey: null,
        pricingRevision: null,
        stripePriceId: null,
        periodStart: null,
        periodEnd: null,
        considerationMicros: proof.amountMinor * 10000,
      };
      const moneyGuard = `guard_${crypto.randomUUID()}`;
      const refundedGuard = `guard_${crypto.randomUUID()}`;
      const observationGuard = `guard_${crypto.randomUUID()}`;
      const refunds = await refundProjection();
      try {
        await sql.batch([
          guard(
            observationGuard,
            `${onDemandRefundFloor} BETWEEN 0 AND 9007199254740991 AND NOT ${observationIdentityConflict()}`,
            [
              ...refundFloorParams(proof.organizationId, proof.fundingRef),
              proof.organizationId,
              proof.fundingRef,
              proof.paymentIntentId,
              proof.chargeId,
            ],
          ),
          ...(proof.refundedAmountMinor > 0
            ? [
                guard(
                  refundedGuard,
                  "EXISTS (SELECT 1 FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ? AND active = 1)",
                  [proof.organizationId, proof.fundingRef],
                ),
              ]
            : []),
          {
            sql: `INSERT INTO stripe_billing_fences (org_id,funding_ref,generation,active,updated_at)
              SELECT ?,?,1,1,? WHERE ${onDemandRefundFloor}>0
              ON CONFLICT(org_id,funding_ref) DO UPDATE SET
                generation=generation+CASE WHEN active=1 THEN 0 ELSE 1 END,
                active=1,updated_at=excluded.updated_at`,
            params: [
              proof.organizationId,
              proof.fundingRef,
              now,
              ...refundFloorParams(proof.organizationId, proof.fundingRef),
            ],
          },
          {
            sql: `INSERT INTO stripe_billing_on_demand_terminals
            (org_id,reference,payment_intent_id,charge_id,status,account_id,mode,billing_authority,
             customer_id,payment_method_id,currency,amount_minor,native_receipt_json,observed_at,exposure_ref)
            VALUES (?,?,?,?,'succeeded',?,?,?,?,?,'usd',?,?,?,?)`,
            params: [
              proof.organizationId,
              proof.reference,
              proof.paymentIntentId,
              proof.chargeId,
              proof.accountId,
              proof.mode,
              proof.billingAuthority,
              proof.customerId,
              proof.paymentMethodId,
              proof.amountMinor,
              JSON.stringify(proof),
              proof.observedAt,
              String(command.exposure_ref),
            ],
          },
          {
            sql: "UPDATE stripe_billing_on_demand_commands SET payment_intent_id = ? WHERE org_id = ? AND reference = ? AND state = 'dispatched' AND (payment_intent_id IS NULL OR payment_intent_id = ?)",
            params: [
              proof.paymentIntentId,
              proof.organizationId,
              proof.reference,
              proof.paymentIntentId,
            ],
          },
          ...lotStatements(grant, now),
          {
            sql: `INSERT INTO stripe_billing_on_demand_funding
            (org_id,reference,funding_ref,exposure_ref,payment_intent_id,charge_id,amount_micros,expires_at,created_at,cap_state,command_state)
            VALUES (?,?,?,?,?,?,?,?,?,'paid','paid')`,
            params: [
              proof.organizationId,
              proof.reference,
              proof.fundingRef,
              String(command.exposure_ref),
              proof.paymentIntentId,
              proof.chargeId,
              grant.amountMicros,
              grant.expiresAt,
              now,
            ],
          },
          {
            sql: "UPDATE org_wallet_cash_exposures SET status = 'paid', source_ref = ?, closed_at = ? WHERE org_id = ? AND ref = ? AND status = 'reserved'",
            params: [
              proof.paymentIntentId,
              now,
              proof.organizationId,
              String(command.exposure_ref),
            ],
          },
          {
            sql: "UPDATE stripe_billing_on_demand_commands SET state = 'paid' WHERE org_id = ? AND reference = ? AND state = 'dispatched' AND payment_intent_id = ?",
            params: [proof.organizationId, proof.reference, proof.paymentIntentId],
          },
          conservationStatement(moneyGuard, grant, now, refunds),
          {
            sql: "DELETE FROM wallet_allocation_guards WHERE id IN (?, ?, ?)",
            params: [moneyGuard, refundedGuard, observationGuard],
          },
        ]);
      } catch (error) {
        const committed = await source("payment-intent", proof.paymentIntentId);
        // A racing worker may have selected its own earlier first funding instant.
        // The persisted original expiry wins; never recompute it on a lost ACK.
        if (
          committed &&
          committed.organizationId === proof.organizationId &&
          committed.fundingRef === proof.fundingRef &&
          committed.chargeId === proof.chargeId &&
          committed.customerId === proof.customerId &&
          committed.amountMicros === grant.amountMicros
        ) {
          await observeNativeRefund(proof);
          return committed;
        }
        throw error;
      }
      const committed = await source("payment-intent", proof.paymentIntentId);
      if (!committed) fail("grant_unavailable");
      return committed;
    },
    async freezeFunding(organizationId: string, fundingRef: string): Promise<number> {
      if (!organizationId || !fundingRef) fail("invalid_grant");
      const now = at();
      const statement = fundingFenceStatement(organizationId, fundingRef, now);
      const claimed = await sql.run(statement.sql, statement.params);
      const generation = Number(claimed.rows[0]?.generation);
      if (claimed.rows.length !== 1 || !Number.isSafeInteger(generation) || generation < 1)
        fail("freeze_unavailable");
      return generation;
    },
    async unfreezeFunding(input: {
      readonly organizationId: string;
      readonly fundingRef: string;
      readonly fenceGeneration: number;
      readonly cumulativeRefundedMicros: number;
    }): Promise<void> {
      const { organizationId, fundingRef, fenceGeneration, cumulativeRefundedMicros } = input;
      const refunds = await refundProjection();
      positive(fenceGeneration);
      if (
        !organizationId ||
        !fundingRef ||
        !Number.isSafeInteger(cumulativeRefundedMicros) ||
        cumulativeRefundedMicros < 0
      )
        fail("invalid_refund");
      const fence = (
        await sql.query(
          "SELECT generation, active FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ?",
          [organizationId, fundingRef],
        )
      )[0];
      if (!fence || Number(fence.generation) !== fenceGeneration) fail("freeze_changed");
      const refunded = (
        await sql.query(
          `SELECT COALESCE(SUM(amount_micros), 0) AS amount FROM ${refunds} WHERE org_id = ? AND funding_ref = ?`,
          [organizationId, fundingRef],
        )
      )[0];
      if (Number(refunded?.amount ?? 0) !== cumulativeRefundedMicros) fail("refund_out_of_order");
      if (refunds === "stripe_billing_refund_receipts_all") {
        const floor = (
          await sql.query(
            `SELECT ${onDemandRefundFloor} AS amount`,
            refundFloorParams(organizationId, fundingRef),
          )
        )[0];
        if (checkedRefundFloor(floor?.amount ?? 0) > cumulativeRefundedMicros)
          fail("refund_out_of_order");
      }
      if (Number(fence.active) === 0) return;
      const check = `guard_${crypto.randomUUID()}`;
      const changed = `${check}_changed`;
      try {
        await sql.batch([
          guard(
            check,
            `EXISTS (SELECT 1 FROM stripe_billing_fences
                 WHERE org_id = ? AND funding_ref = ? AND generation = ? AND active = 1)
                 AND (SELECT COALESCE(SUM(amount_micros), 0) FROM ${refunds}
                      WHERE org_id = ? AND funding_ref = ?) = ?
                 ${refunds === "stripe_billing_refund_receipts_all" ? `AND ? >= ${onDemandRefundFloor}` : ""}`,
            [
              organizationId,
              fundingRef,
              fenceGeneration,
              organizationId,
              fundingRef,
              cumulativeRefundedMicros,
              ...(refunds === "stripe_billing_refund_receipts_all"
                ? [cumulativeRefundedMicros, ...refundFloorParams(organizationId, fundingRef)]
                : []),
            ],
          ),
          {
            sql: `UPDATE stripe_billing_fences SET active = 0, updated_at = ?
                  WHERE org_id = ? AND funding_ref = ? AND generation = ? AND active = 1`,
            params: [at(), organizationId, fundingRef, fenceGeneration],
          },
          guard(changed, "changes() = 1"),
          {
            sql: "DELETE FROM wallet_allocation_guards WHERE id IN (?, ?)",
            params: [check, changed],
          },
        ]);
      } catch (error) {
        const committed = (
          await sql.query(
            "SELECT generation, active FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ?",
            [organizationId, fundingRef],
          )
        )[0];
        const sum = (
          await sql.query(
            `SELECT COALESCE(SUM(amount_micros), 0) AS amount FROM ${refunds} WHERE org_id = ? AND funding_ref = ?`,
            [organizationId, fundingRef],
          )
        )[0];
        if (
          committed &&
          Number(committed.generation) === fenceGeneration &&
          Number(committed.active) === 0 &&
          Number(sum?.amount ?? 0) === cumulativeRefundedMicros &&
          (refunds !== "stripe_billing_refund_receipts_all" ||
            Number(
              (
                await sql.query(
                  `SELECT ${onDemandRefundFloor} AS amount`,
                  refundFloorParams(organizationId, fundingRef),
                )
              )[0]?.amount ?? 0,
            ) <= cumulativeRefundedMicros)
        )
          return;
        throw error;
      }
    },
    async refund(input: {
      readonly refundId: string;
      readonly grant: BillingGrant;
      readonly amountMicros: number;
      readonly cumulativeRefundedMicros: number;
      readonly fenceGeneration: number;
      readonly releaseFreeze?: boolean;
      readonly native?: StripeOnDemandFundingProof;
    }): Promise<RefundReceipt> {
      const {
        grant: expected,
        refundId,
        amountMicros,
        cumulativeRefundedMicros,
        fenceGeneration,
      } = input;
      const refunds = await refundProjection();
      positive(amountMicros);
      positive(cumulativeRefundedMicros);
      positive(fenceGeneration);
      if (!refundId || cumulativeRefundedMicros > expected.considerationMicros)
        fail("invalid_refund");
      const current = await source(expected.sourceType, expected.sourceId);
      if (!current || !sameGrant(current, expected)) fail("grant_conflict");
      let native: StripeOnDemandFundingProof | undefined;
      if (expected.sourceType === "payment-intent") {
        if (!input.native) fail("invalid_native_proof");
        native = sanitizedFundingProof(input.native);
        const command = (
          await sql.query(
            "SELECT * FROM stripe_billing_on_demand_commands WHERE org_id = ? AND funding_ref = ?",
            [expected.organizationId, expected.fundingRef],
          )
        )[0];
        if (
          !command ||
          !matchesOnDemandCommand(command, native) ||
          native.paymentIntentId !== expected.sourceId ||
          native.chargeId !== expected.chargeId ||
          native.observedAt < String(command.dispatched_at)
        )
          fail("invalid_native_proof");
        await observeNativeRefund(native);
        if (native.refundedAmountMinor * 10000 < cumulativeRefundedMicros)
          fail("invalid_native_proof");
      }
      if (
        native &&
        input.releaseFreeze !== false &&
        native.refundedAmountMinor * 10000 > cumulativeRefundedMicros
      )
        fail("refund_drain_incomplete");
      const prior = await receipt(refundId);
      if (prior) {
        if (
          prior.organizationId !== expected.organizationId ||
          prior.fundingRef !== expected.fundingRef ||
          prior.amountMicros !== amountMicros ||
          prior.cumulativeRefundedMicros !== cumulativeRefundedMicros
        )
          fail("refund_conflict");
        await clearFenceIfRequested();
        return prior;
      }
      const priorRows = await sql.query(
        `SELECT COALESCE(SUM(amount_micros), 0) AS refunded,
                COALESCE(MAX(target_revoked_micros), 0) AS target,
                COALESCE(SUM(debit_micros), 0) AS debited,
                COALESCE(SUM(expired_micros), 0) AS expired
         FROM ${refunds} WHERE org_id = ? AND funding_ref = ?`,
        [expected.organizationId, expected.fundingRef],
      );
      const previousRefunded = Number(priorRows[0]?.refunded ?? 0);
      const previousTarget = Number(priorRows[0]?.target ?? 0);
      const previousDebit = Number(priorRows[0]?.debited ?? 0);
      const previousExpired = Number(priorRows[0]?.expired ?? 0);
      if (previousRefunded + amountMicros !== cumulativeRefundedMicros) fail("refund_out_of_order");
      const target =
        cumulativeRefundedMicros === expected.considerationMicros
          ? expected.amountMicros
          : Number(
              (BigInt(expected.amountMicros) * BigInt(cumulativeRefundedMicros)) /
                BigInt(expected.considerationMicros),
            );
      const delta = target - previousTarget;
      if (!Number.isSafeInteger(delta) || delta < 0) fail("refund_conflict");
      const now = at();
      if (native && now < native.observedAt) fail("invalid_time");
      const org = expected.organizationId;
      const ref = expected.fundingRef;
      const heldRefs = await sql.query(
        "SELECT DISTINCT debit_ref FROM wallet_credit_allocations WHERE org_id = ? AND lot_ref = ? AND debit_type = 'hold'",
        [org, ref],
      );
      const closures: SqlStatement[] = [];
      const closureGuards: string[] = [];
      for (const item of heldRefs) {
        const holdRef = String(item.debit_ref);
        const state = (
          await sql.query("SELECT * FROM org_wallet_holds WHERE org_id = ? AND ledger_ref = ?", [
            org,
            holdRef,
          ])
        )[0];
        if (state && (state.state !== "live" || state.money_policy !== "usd-micros-v2"))
          fail("hold_conflict");
        const totals = (
          await sql.query(
            `SELECT (SELECT COALESCE(SUM(amount_micros), 0) FROM wallet_credit_allocations
                   WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?) AS allocated,
                  (SELECT COALESCE(SUM(held_delta_micros), 0) FROM ledger WHERE org_id = ? AND ref = ?) AS held`,
            [org, holdRef, org, holdRef],
          )
        )[0];
        const held = Number(totals?.held ?? 0);
        if (held <= 0 || held !== Number(totals?.allocated)) fail("hold_conflict");
        if (state) {
          closures.push({
            sql: `UPDATE org_wallet_holds SET state = 'released', released_micros = amount_micros,
                    closed_at = ?, closure_reason = 'refund' WHERE org_id = ? AND ledger_ref = ? AND state = 'live'
                    AND money_policy = 'usd-micros-v2'`,
            params: [now, org, holdRef],
          });
          const stateGuard = `guard_${crypto.randomUUID()}`;
          closureGuards.push(stateGuard);
          closures.push(guard(stateGuard, "changes() = 1"));
        }
        const balanceGuard = `guard_${crypto.randomUUID()}`;
        closureGuards.push(balanceGuard);
        closures.push(
          guard(
            balanceGuard,
            `(SELECT COALESCE(SUM(amount_micros), 0) FROM wallet_credit_allocations
            WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?) = ?
           AND (SELECT COALESCE(SUM(held_delta_micros), 0) FROM ledger WHERE org_id = ? AND ref = ?) = ?`,
            [org, holdRef, held, org, holdRef, held],
          ),
        );
        closures.push({
          sql: "DELETE FROM wallet_credit_allocations WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?",
          params: [org, holdRef],
        });
        closures.push({
          sql: `INSERT INTO ledger (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at)
                VALUES (?, ?, 'release', ?, 0, ?, ?)`,
          params: [`led_${crypto.randomUUID()}`, org, holdRef, -held, now],
        });
      }
      const lotRows = await sql.query(
        `SELECT l.amount_micros, l.expires_at,
                COALESCE(SUM(CASE WHEN a.debit_type IN ('capture', 'usage_debit') THEN a.amount_micros ELSE 0 END), 0) AS spent
         FROM wallet_credit_lots l LEFT JOIN wallet_credit_allocations a
           ON a.org_id = l.org_id AND a.lot_ref = l.ref
         WHERE l.org_id = ? AND l.ref = ? GROUP BY l.org_id, l.ref`,
        [org, ref],
      );
      const lot = lotRows[0];
      if (
        expected.amountMicros > 0 &&
        (!lot || Number(lot.amount_micros) !== expected.amountMicros)
      )
        fail("grant_conflict");
      if (expected.amountMicros === 0 && lot) fail("grant_conflict");
      const spent = Number(lot?.spent ?? 0);
      const unspent = expected.amountMicros - spent - previousDebit - previousExpired;
      if (!Number.isSafeInteger(unspent) || unspent < 0) fail("conservation_violated");
      const unused = Math.min(delta, unspent);
      const expired = lot?.expires_at != null && String(lot.expires_at) <= now ? unused : 0;
      const debit = unused - expired;
      const receivable = delta - unused;
      const fenceId = `guard_${crypto.randomUUID()}`;
      const consistencyId = `guard_${crypto.randomUUID()}`;
      const drainId = `guard_${crypto.randomUUID()}`;
      try {
        await sql.batch([
          guard(
            fenceId,
            `EXISTS (SELECT 1 FROM stripe_billing_fences
                     WHERE org_id = ? AND funding_ref = ? AND generation = ? AND active = 1)
                     AND (SELECT COALESCE(SUM(amount_micros), 0) FROM ${refunds}
                          WHERE org_id = ? AND funding_ref = ?) = ?
                     AND (SELECT COALESCE(MAX(target_revoked_micros), 0) FROM ${refunds}
                          WHERE org_id = ? AND funding_ref = ?) = ?`,
            [org, ref, fenceGeneration, org, ref, previousRefunded, org, ref, previousTarget],
          ),
          ...closures,
          guard(
            consistencyId,
            `NOT EXISTS (SELECT 1 FROM wallet_credit_allocations
                  WHERE org_id = ? AND lot_ref = ? AND debit_type = 'hold')
                  AND (SELECT COALESCE(SUM(amount_micros), 0) FROM wallet_credit_allocations
                       WHERE org_id = ? AND lot_ref = ? AND debit_type IN ('capture', 'usage_debit')) = ?`,
            [org, ref, org, ref, spent],
          ),
          {
            sql: native
              ? `INSERT INTO stripe_billing_on_demand_refunds
              (refund_id, org_id, funding_ref, amount_micros, cumulative_refunded_micros,
               target_revoked_micros, debit_micros, receivable_micros, expired_micros, created_at,
               fence_generation, native_receipt_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              : `INSERT INTO stripe_billing_refunds
              (refund_id, org_id, funding_ref, amount_micros, cumulative_refunded_micros,
               target_revoked_micros, debit_micros, receivable_micros, expired_micros, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              refundId,
              org,
              ref,
              amountMicros,
              cumulativeRefundedMicros,
              target,
              debit,
              receivable,
              expired,
              now,
              ...(native ? [fenceGeneration, JSON.stringify(native)] : []),
            ],
          },
          ...(native && input.releaseFreeze !== false
            ? [
                guard(drainId, `? >= ${onDemandRefundFloor}`, [
                  cumulativeRefundedMicros,
                  ...refundFloorParams(org, ref),
                ]),
              ]
            : []),
          ...(input.releaseFreeze === false
            ? []
            : [
                {
                  sql: "UPDATE stripe_billing_fences SET active = 0, updated_at = ? WHERE org_id = ? AND funding_ref = ? AND generation = ? AND active = 1",
                  params: [now, org, ref, fenceGeneration],
                },
              ]),
          {
            sql: `DELETE FROM wallet_allocation_guards WHERE id IN (${[fenceId, consistencyId, drainId, ...closureGuards].map(() => "?").join(", ")})`,
            params: [fenceId, consistencyId, drainId, ...closureGuards],
          },
        ]);
      } catch (error) {
        const committed = await receipt(refundId);
        if (
          committed &&
          committed.organizationId === org &&
          committed.fundingRef === ref &&
          committed.amountMicros === amountMicros &&
          committed.cumulativeRefundedMicros === cumulativeRefundedMicros
        ) {
          await clearFenceIfRequested();
          return committed;
        }
        throw error;
      }
      const committed = await receipt(refundId);
      if (!committed) fail("refund_unavailable");
      return committed;

      async function clearFenceIfRequested(): Promise<void> {
        if (input.releaseFreeze === false) return;
        if (native) {
          const cumulative = Number(
            (
              await sql.query(
                `SELECT COALESCE(SUM(amount_micros),0) AS amount FROM ${refunds} WHERE org_id=? AND funding_ref=?`,
                [expected.organizationId, expected.fundingRef],
              )
            )[0]?.amount ?? 0,
          );
          if (cumulative < native.refundedAmountMinor * 10000) fail("refund_drain_incomplete");
          await store.unfreezeFunding({
            organizationId: expected.organizationId,
            fundingRef: expected.fundingRef,
            fenceGeneration,
            cumulativeRefundedMicros: cumulative,
          });
          return;
        }
        const currentFence = await sql.query(
          "SELECT generation, active FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ?",
          [expected.organizationId, expected.fundingRef],
        );
        // A lost acknowledgement may follow a committed batch which already
        // removed this generation. Never clear a newer worker's freeze.
        if (currentFence.length === 0) fail("freeze_changed");
        if (Number(currentFence[0]?.generation) !== fenceGeneration) fail("freeze_changed");
        if (Number(currentFence[0]?.active) === 0) return;
        const result = await sql.run(
          `UPDATE stripe_billing_fences SET active = 0, updated_at = ?
            WHERE org_id = ? AND funding_ref = ? AND generation = ? AND active = 1`,
          [at(), expected.organizationId, expected.fundingRef, fenceGeneration],
        );
        if (result.changes !== 1) fail("freeze_changed");
      }
    },
  };
  const frozen = Object.freeze(store);
  storeOrigins.set(frozen, { sql, clock });
  return frozen;
}
