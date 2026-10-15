import { type BillingConfig, parseBillingConfig } from "./billing-config.ts";
import { MIGRATIONS } from "./db-schema.ts";
import {
  assertHostedBillingFinancialRealm,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import { canonicalDigest, canonicalJson } from "./json.ts";
import { prepareLedgerEligibleCapacity } from "./ledger.ts";
import { minorToMicros } from "./money.ts";
import {
  type OrgBillingFreshAdmissionOrigin,
  readOrgBillingFreshAdmissionOrigin,
} from "./org-billing.ts";
import {
  createOrgCashExposureReservations,
  orgCashCapPeriod,
  readOrgOnDemandConsent,
} from "./org-limit-policy.ts";
import {
  calculateOrgOnDemandFunding,
  type OrgOnDemandTerms,
  OrgOnDemandTermsError,
  parseOrgOnDemandTerms,
  resolveOrgOnDemandCreditExpiry,
  validateOrgOnDemandCashCap,
} from "./org-on-demand-terms.ts";
import type { Clock, Row, Sql, SqlParam, SqlStatement } from "./ports.ts";
import type { StripeBillingClient, StripeBillingObject } from "./stripe-billing-client.ts";
import { assertStripeBillingStoreOrigin, type StripeBillingStore } from "./stripe-billing-store.ts";
import {
  type StripeOnDemandCardProof,
  type StripeOnDemandFundingProof,
  type StripeOnDemandOriginalMetadata,
  verifyStripeOnDemandCard,
  verifyStripeOnDemandFunding,
} from "./stripe-on-demand-verification.ts";

const UNKNOWN_ACK_CUTOFF_MS = 23 * 3600_000;
const MAX_READBACK_PAGES = 3;
const READBACK_PAGE_SIZE = 100;
const MAX_INSTANT_MS = 253402300799000;
// PaymentIntent amount bounds for the existing 2024-06-20 USD card protocol.
// These validate operator choices; they are not selected funding-policy values.
const STRIPE_USD_MINIMUM_MINOR = 50;
const STRIPE_USD_MAXIMUM_MINOR = 99_999_999;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export class StripeOnDemandError extends Error {
  readonly status: 400 | 409 | 503;
  constructor(
    readonly code:
      | "invalid_argument"
      | "unqualified_origin"
      | "schema_unavailable"
      | "consent_required"
      | "reference_conflict"
      | "unavailable",
  ) {
    super(code);
    this.name = "StripeOnDemandError";
    this.status =
      code === "invalid_argument"
        ? 400
        : code === "consent_required" || code === "reference_conflict"
          ? 409
          : 503;
  }
}
type Code = StripeOnDemandError["code"];
function fail(code: Code): never {
  throw new StripeOnDemandError(code);
}
function exact(value: unknown, keys: readonly string[], code: Code): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (Reflect.ownKeys(value).length !== keys.length) fail(code);
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property)) fail(code);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, code: Code): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    fail(code);
  return value;
}
function identifier(value: unknown, code: Code): string {
  if (typeof value !== "string" || !ID.test(value)) fail(code);
  return value;
}
function processorId(value: unknown, prefix: string, code: Code): string {
  const result = text(value, 255, code);
  if (!result.startsWith(prefix) || !/^[A-Za-z0-9_]+$/u.test(result.slice(prefix.length)))
    fail(code);
  return result;
}
function instant(value: unknown, code: Code): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isSafeInteger(Date.parse(value)) ||
    Date.parse(value) > MAX_INSTANT_MS ||
    new Date(value).toISOString() !== value
  )
    fail(code);
  return value;
}
function positive(value: unknown, code: Code): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}
function guard(condition: string, params: readonly SqlParam[]): readonly SqlStatement[] {
  const id = `guard_${crypto.randomUUID()}`;
  return [
    {
      sql: `INSERT INTO wallet_allocation_guards (id, valid) VALUES (?, CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
      params: [id, ...params],
    },
    { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [id] },
  ];
}

export interface StripeOnDemandConsentEnvelope {
  readonly kind: "org-limit-policy-consent-v1";
  readonly version: 1;
  readonly publicResult: {
    readonly onLimit: "on-demand";
    readonly capabilities: {
      readonly stop: true;
      readonly prepaid: true;
      readonly postpaid: false;
      readonly "on-demand": true;
    };
    readonly consentRevision: string;
    readonly cashCapMinor: number;
    readonly periodStart: string;
    readonly periodEnd: string;
  };
  readonly policyVersion: number;
  readonly authorizedPrincipal: string;
  readonly acceptedAt: string;
  readonly acceptedTerms: OrgOnDemandTerms;
  readonly selectedCardProof: StripeOnDemandCardProof;
}

/** Closed persisted representation, not fresh native/card/actor authorization. */
export function parseStripeOnDemandConsentEnvelope(input: unknown): StripeOnDemandConsentEnvelope {
  const value = exact(
    input,
    [
      "kind",
      "version",
      "publicResult",
      "policyVersion",
      "authorizedPrincipal",
      "acceptedAt",
      "acceptedTerms",
      "selectedCardProof",
    ],
    "consent_required",
  );
  if (value.kind !== "org-limit-policy-consent-v1" || value.version !== 1) fail("consent_required");
  const policyVersion = positive(value.policyVersion, "consent_required");
  const authorizedPrincipal = text(value.authorizedPrincipal, 512, "consent_required");
  const acceptedAt = instant(value.acceptedAt, "consent_required");
  let acceptedTerms: OrgOnDemandTerms;
  try {
    acceptedTerms = parseOrgOnDemandTerms(value.acceptedTerms);
  } catch {
    fail("consent_required");
  }
  if (
    acceptedAt < acceptedTerms.validity.validFrom ||
    acceptedAt >= acceptedTerms.validity.validUntil
  )
    fail("consent_required");
  const view = exact(
    value.publicResult,
    ["onLimit", "capabilities", "consentRevision", "cashCapMinor", "periodStart", "periodEnd"],
    "consent_required",
  );
  const capabilities = exact(
    view.capabilities,
    ["stop", "prepaid", "postpaid", "on-demand"],
    "consent_required",
  );
  if (
    view.onLimit !== "on-demand" ||
    capabilities.stop !== true ||
    capabilities.prepaid !== true ||
    capabilities.postpaid !== false ||
    capabilities["on-demand"] !== true ||
    view.consentRevision !== acceptedTerms.consentRevision
  )
    fail("consent_required");
  let cashCapMinor: number;
  try {
    cashCapMinor = validateOrgOnDemandCashCap(acceptedTerms, view.cashCapMinor as number);
  } catch {
    fail("consent_required");
  }
  const period = orgCashCapPeriod(acceptedAt);
  if (view.periodStart !== period.periodStart || view.periodEnd !== period.periodEnd)
    fail("consent_required");
  const proof = exact(
    value.selectedCardProof,
    [
      "kind",
      "organizationId",
      "customerId",
      "paymentMethodId",
      "setupIntentId",
      "accountId",
      "mode",
      "financialRealm",
      "billingAuthority",
      "verifiedAt",
    ],
    "consent_required",
  );
  if (proof.kind !== "stripe-saved-card" || proof.mode !== "test") fail("consent_required");
  const verifiedAt = instant(proof.verifiedAt, "consent_required");
  if (verifiedAt > acceptedAt || verifiedAt < acceptedTerms.validity.validFrom)
    fail("consent_required");
  const selectedCardProof: StripeOnDemandCardProof = Object.freeze({
    kind: "stripe-saved-card",
    mode: "test",
    organizationId: identifier(proof.organizationId, "consent_required"),
    customerId: processorId(proof.customerId, "cus_", "consent_required"),
    paymentMethodId: processorId(proof.paymentMethodId, "pm_", "consent_required"),
    setupIntentId:
      proof.setupIntentId === null
        ? null
        : processorId(proof.setupIntentId, "seti_", "consent_required"),
    accountId: processorId(proof.accountId, "acct_", "consent_required"),
    financialRealm: text(proof.financialRealm, 256, "consent_required"),
    billingAuthority: text(proof.billingAuthority, 256, "consent_required"),
    verifiedAt,
  });
  return Object.freeze({
    kind: "org-limit-policy-consent-v1",
    version: 1,
    publicResult: Object.freeze({
      onLimit: "on-demand",
      capabilities: Object.freeze({
        stop: true,
        prepaid: true,
        postpaid: false,
        "on-demand": true,
      }),
      consentRevision: acceptedTerms.consentRevision,
      cashCapMinor,
      ...period,
    }),
    policyVersion,
    authorizedPrincipal,
    acceptedAt,
    acceptedTerms,
    selectedCardProof,
  });
}

export interface StripeOnDemandReceipt {
  readonly organizationId: string;
  readonly reference: string;
  readonly admissionNamespace: "org-hold" | "org-usage";
  readonly admissionReference: string;
  readonly state: "prepared" | "pending" | "funded" | "canceled" | "abandoned";
  readonly amountMinor: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly reconciliationRequired: boolean;
}
export type StripeOnDemandAdmissionResult =
  | { readonly state: "covered" }
  | { readonly state: "funded"; readonly receipt: StripeOnDemandReceipt }
  | { readonly state: "pending" | "refused"; readonly receipt: StripeOnDemandReceipt | null };

export interface StripeOnDemandService {
  readonly terms: OrgOnDemandTerms;
  readTerms(): OrgOnDemandTerms;
  /** Caller is the exact-Org authenticated policy writer; this proves only terms/card observations. */
  verifyConsent(input: {
    readonly organizationId: string;
    readonly authorizedPrincipal: string;
    readonly termsRevision: string;
    readonly consentRevision: string;
    readonly cashCapMinor: number;
    readonly paymentMethodId: string;
    readonly setupIntentId?: string;
  }): Promise<{
    readonly acceptedTerms: OrgOnDemandTerms;
    readonly selectedCardProof: StripeOnDemandCardProof;
  }>;
  beforeNewAdmission(token: unknown): Promise<StripeOnDemandAdmissionResult>;
  readOriginal(input: {
    readonly organizationId: string;
    readonly reference: string;
  }): Promise<StripeOnDemandReceipt | null>;
  /** GET-only native recovery; no current consent, card lookup or new dispatch. */
  drainOriginal(input: {
    readonly organizationId: string;
    readonly reference: string;
  }): Promise<StripeOnDemandReceipt | null>;
  drainForPaymentIntent(paymentIntentId: string): Promise<StripeOnDemandReceipt | null>;
  /** Original refund owner reads qualified native proof; this method never grants or refunds. */
  readFundingProofForPaymentIntent(
    paymentIntentId: string,
  ): Promise<StripeOnDemandFundingProof | null>;
  drainPending(limit: number): Promise<readonly StripeOnDemandReceipt[]>;
  /** Append after the policy's stop/version UPDATE, within its same atomic batch. */
  prepareWithdrawalStatements(input: {
    readonly organizationId: string;
    readonly fromVersion: number;
    readonly toVersion: number;
    readonly instant: string;
  }): readonly SqlStatement[];
}
interface Origin {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
  readonly store: StripeBillingStore;
  readonly billingConfig: BillingConfig;
  readonly configJson: string;
}
const origins = new WeakMap<StripeOnDemandService, Origin>();

export function assertStripeOnDemandService(
  service: unknown,
  context: {
    readonly sql: Sql;
    readonly clock: Clock;
    readonly billingConfig?: BillingConfig;
    readonly client?: StripeBillingClient;
    readonly realm?: HostedBillingFinancialRealm;
    readonly store?: StripeBillingStore;
  },
): asserts service is StripeOnDemandService {
  const origin = origins.get(service as StripeOnDemandService);
  if (
    !origin ||
    origin.sql !== context.sql ||
    origin.clock !== context.clock ||
    canonicalJson(origin.billingConfig) !== origin.configJson ||
    (context.billingConfig !== undefined &&
      canonicalJson(context.billingConfig) !== origin.configJson) ||
    (context.client !== undefined && context.client !== origin.client) ||
    (context.realm !== undefined && context.realm !== origin.realm) ||
    (context.store !== undefined && context.store !== origin.store)
  )
    fail("unqualified_origin");
}

/** Exact reviewed 0100 objects, not table names or JSON claims alone. */
export async function assertStripeOnDemandSchema(sql: Sql): Promise<void> {
  const migration = MIGRATIONS.find((item) => item.name === "0100_hosted_on_demand.sql");
  if (!migration) fail("schema_unavailable");
  const names = [
    ...migration.sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+([a-z0-9_]+)/gu),
  ].filter(
    (match) =>
      match[2]?.startsWith("stripe_billing_on_demand_") ||
      match[2] === "stripe_on_demand_exposure_status_parent",
  );
  if (names.length < 20) fail("schema_unavailable");
  const rows = await sql.query(
    "SELECT type, name, sql FROM sqlite_schema WHERE name IN (SELECT value FROM json_each(?))",
    [JSON.stringify(names.map((match) => match[2]))],
  );
  const normalize = (value: string) => value.trim().replace(/;$/u, "").replace(/\s+/gu, " ");
  for (const match of names) {
    const kind = match[1];
    const name = match[2];
    if (!kind || !name) fail("schema_unavailable");
    const expected = migration.sql.match(
      new RegExp(
        `CREATE\\s+(?:UNIQUE\\s+)?${kind}\\s+${name}\\b[\\s\\S]*?${kind === "TRIGGER" ? "^END\\s*;" : ";"}`,
        "mu",
      ),
    )?.[0];
    const actual = rows.find((row) => row.type === kind.toLowerCase() && row.name === name)?.sql;
    if (!expected || typeof actual !== "string" || normalize(expected) !== normalize(actual))
      fail("schema_unavailable");
  }
}

interface Command {
  readonly row: Row;
  readonly admission: OrgBillingFreshAdmissionOrigin;
  readonly terms: OrgOnDemandTerms;
  readonly consent: StripeOnDemandConsentEnvelope;
  readonly metadata: StripeOnDemandOriginalMetadata;
  readonly request: Readonly<Record<string, unknown>>;
}

/** No native effect until a genuine fresh owner wins its durable first-dispatch batch. */
export async function createStripeOnDemand(options: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
  readonly store: StripeBillingStore;
  readonly billingConfig: BillingConfig;
  readonly terms: OrgOnDemandTerms;
}): Promise<StripeOnDemandService> {
  const { sql, clock, client, realm, store, billingConfig } = options;
  const config = parseBillingConfig(canonicalJson(billingConfig));
  if (!config) fail("unqualified_origin");
  const terms = parseOrgOnDemandTerms(options.terms);
  if (
    terms.replenishment.minimumChargeMinor < STRIPE_USD_MINIMUM_MINOR ||
    terms.replenishment.maximumChargeMinor > STRIPE_USD_MAXIMUM_MINOR
  )
    fail("unqualified_origin");
  assertHostedBillingFinancialRealm(realm, {
    sql,
    client,
    billingAuthority: realm.billingAuthority,
  });
  assertStripeBillingStoreOrigin(store, { sql, clock });
  await assertStripeOnDemandSchema(sql);
  const exposures = createOrgCashExposureReservations({ sql, clock });
  const now = () => instant(clock().toISOString(), "unavailable");
  const context = { sql, clock, client, realm, store, billingConfig };
  const cashReference = async (
    admission: Pick<OrgBillingFreshAdmissionOrigin, "organizationId" | "namespace" | "reference">,
  ) =>
    `ondemand_${(await canonicalDigest(["org-on-demand-v1", admission.organizationId, admission.namespace, admission.reference])).slice(7)}`;
  const rowFor = async (org: string, ref: string) =>
    (
      await sql.query(
        "SELECT * FROM stripe_billing_on_demand_commands WHERE org_id = ? AND reference = ?",
        [org, ref],
      )
    )[0];

  async function command(row: Row): Promise<Command> {
    try {
      const admission = JSON.parse(String(row.admission_json)) as OrgBillingFreshAdmissionOrigin;
      if (admission.namespace !== "org-hold" && admission.namespace !== "org-usage")
        fail("unavailable");
      identifier(admission.organizationId, "unavailable");
      identifier(admission.reference, "unavailable");
      if (
        !DIGEST.test(admission.fingerprint) ||
        typeof admission.receiptFingerprint !== "string" ||
        !admission.receiptFingerprint ||
        !Number.isSafeInteger(admission.amountMicros) ||
        admission.amountMicros <= 0 ||
        typeof admission.hostedPaidFreeExclusion !== "boolean" ||
        admission.sourceContext.kind !== "org-billing" ||
        admission.allocationAdmission.onLimit !== "on-demand" ||
        admission.allocationAdmission.allowPurchasedCredit !== true ||
        row.org_id !== admission.organizationId ||
        row.reference !== (await cashReference(admission)) ||
        row.fingerprint !== admission.fingerprint
      )
        fail("unavailable");
      const savedTerms = parseOrgOnDemandTerms(JSON.parse(String(row.terms_json)));
      const consent = parseStripeOnDemandConsentEnvelope(JSON.parse(String(row.consent_json)));
      const card = consent.selectedCardProof;
      const amountMinor = positive(row.amount_minor, "unavailable");
      minorToMicros(amountMinor);
      const createdAt = instant(row.created_at, "unavailable");
      const period = orgCashCapPeriod(createdAt);
      const deadline =
        savedTerms.validity.validUntil < period.periodEnd
          ? savedTerms.validity.validUntil
          : period.periodEnd;
      if (
        row.period_start !== period.periodStart ||
        row.period_end !== period.periodEnd ||
        row.terms_expires_at !== deadline ||
        createdAt < savedTerms.validity.validFrom ||
        createdAt >= deadline ||
        row.policy_version !== consent.policyVersion ||
        row.policy_version !== admission.allocationAdmission.policyVersion ||
        row.consent_revision !== savedTerms.consentRevision ||
        row.consent_revision !== consent.publicResult.consentRevision ||
        row.terms_revision !== savedTerms.termsRevision ||
        canonicalJson(savedTerms) !== canonicalJson(consent.acceptedTerms) ||
        row.authorized_principal !== consent.authorizedPrincipal ||
        row.cap_minor !== consent.publicResult.cashCapMinor ||
        row.org_id !== card.organizationId ||
        row.customer_id !== card.customerId ||
        row.payment_method_id !== card.paymentMethodId ||
        row.setup_intent_id !== card.setupIntentId ||
        row.account_id !== card.accountId ||
        row.mode !== card.mode ||
        row.billing_authority !== card.billingAuthority ||
        row.credit_expiry_kind !== savedTerms.purchaseCreditExpiry.kind ||
        row.credit_expiry_seconds !==
          (savedTerms.purchaseCreditExpiry.kind === "none"
            ? null
            : savedTerms.purchaseCreditExpiry.seconds) ||
        row.funding_ref !== `ondemand:${String(row.reference).slice(9)}` ||
        row.stripe_key !== `takoserver:org-on-demand:${String(row.reference).slice(9)}`
      )
        fail("unavailable");
      const metadata: StripeOnDemandOriginalMetadata = Object.freeze({
        organizationId: admission.organizationId,
        reference: String(row.reference),
        fingerprint: admission.fingerprint,
        fundingRef: String(row.funding_ref),
        stripeAccountId: String(row.account_id),
        financialRealm: card.financialRealm,
        billingAuthority: String(row.billing_authority),
      });
      const request = JSON.parse(String(row.request_json)) as Record<string, unknown>;
      if (
        canonicalJson(request) !==
        canonicalJson({
          currency: "usd",
          amount: amountMinor,
          customer: card.customerId,
          payment_method: card.paymentMethodId,
          payment_method_types: ["card"],
          off_session: true,
          confirm: true,
          metadata,
        })
      )
        fail("unavailable");
      if (!["prepared", "dispatched", "paid", "canceled", "abandoned"].includes(String(row.state)))
        fail("unavailable");
      if (row.dispatched_at != null) instant(row.dispatched_at, "unavailable");
      if ((row.state === "prepared" || row.state === "abandoned") !== (row.dispatched_at == null))
        fail("unavailable");
      if (row.payment_intent_id != null) processorId(row.payment_intent_id, "pi_", "unavailable");
      return { row, admission, terms: savedTerms, consent, metadata, request };
    } catch (error) {
      if (error instanceof StripeOnDemandError) throw error;
      return fail("unavailable");
    }
  }
  function assertOriginalRealm(original: Command): void {
    if (
      original.row.account_id !== realm.accountId ||
      original.row.mode !== realm.mode ||
      original.row.billing_authority !== realm.billingAuthority ||
      original.metadata.financialRealm !== realm.financialRealm
    )
      fail("unqualified_origin");
  }
  function receipt(original: Command): StripeOnDemandReceipt {
    const row = original.row;
    return Object.freeze({
      organizationId: original.admission.organizationId,
      reference: String(row.reference),
      admissionNamespace: original.admission.namespace,
      admissionReference: original.admission.reference,
      state:
        row.state === "paid"
          ? "funded"
          : row.state === "dispatched"
            ? "pending"
            : (row.state as "prepared" | "canceled" | "abandoned"),
      amountMinor: Number(row.amount_minor),
      periodStart: String(row.period_start),
      periodEnd: String(row.period_end),
      reconciliationRequired:
        row.state === "dispatched" &&
        Date.parse(now()) - Date.parse(String(row.dispatched_at)) >= UNKNOWN_ACK_CUTOFF_MS,
    });
  }
  function acceptedStatement(admission: OrgBillingFreshAdmissionOrigin): SqlStatement {
    const table =
      admission.namespace === "org-hold" ? "org_wallet_holds" : "org_wallet_usage_records";
    return {
      sql: `SELECT fingerprint, money_policy FROM ${table} WHERE org_id = ? AND ref = ?`,
      params: [admission.organizationId, admission.reference],
    };
  }
  async function accepted(admission: OrgBillingFreshAdmissionOrigin): Promise<boolean> {
    const statement = acceptedStatement(admission);
    const rows = await sql.query(statement.sql, statement.params);
    if (rows.length > 1) fail("unavailable");
    if (!rows[0]) return false;
    if (
      rows[0].fingerprint !== admission.receiptFingerprint ||
      rows[0].money_policy !== "usd-micros-v2"
    )
      fail("reference_conflict");
    return true;
  }
  async function capacity(admission: OrgBillingFreshAdmissionOrigin, at: string) {
    return await prepareLedgerEligibleCapacity(sql, {
      organizationId: admission.organizationId,
      now: at,
      amountMicros: admission.amountMicros,
      hostedPaidFreeExclusion: admission.hostedPaidFreeExclusion,
      allocationAdmission: { allowPurchasedCredit: true },
    });
  }
  async function sourceGuard(
    admission: OrgBillingFreshAdmissionOrigin,
    at: string,
    deficit: number,
  ): Promise<readonly SqlStatement[]> {
    const table =
      admission.namespace === "org-hold" ? "org_wallet_holds" : "org_wallet_usage_records";
    const funds = await capacity(admission, at);
    const workspace = admission.attribution.workspaceRef;
    return guard(
      `NOT EXISTS (SELECT 1 FROM ${table} WHERE org_id = ? AND ref = ?)
      AND NOT EXISTS (SELECT 1 FROM org_wallet_usage_records WHERE org_id = ? AND state = 'pending')
      AND EXISTS (SELECT 1 FROM (${funds.statement.sql}) capacity WHERE receivable_blocked = 0 AND deficit_micros = ? AND deficit_micros > 0)
      ${workspace === null ? "" : "AND NOT EXISTS (SELECT 1 FROM org_wallet_workspace_bindings WHERE workspace_ref = ? AND org_id <> ?)"}`,
      [
        admission.organizationId,
        admission.reference,
        admission.organizationId,
        ...(funds.statement.params ?? []),
        deficit,
        ...(workspace === null ? [] : [workspace, admission.organizationId]),
      ],
    );
  }
  function consentGuard(original: Command, at: string): readonly SqlStatement[] {
    const row = original.row;
    return guard(
      `? >= ? AND ? < ? AND EXISTS (SELECT 1 FROM org_wallet_limit_policies p
      WHERE p.org_id = ? AND p.on_limit = 'on-demand' AND p.policy_version = ? AND p.consent_revision = ? AND p.cash_cap_minor = ? AND p.authorized_principal = ?)
      AND EXISTS (SELECT 1 FROM org_wallet_limit_policy_commands c WHERE c.org_id = ? AND c.result_json = ?)`,
      [
        at,
        original.terms.validity.validFrom,
        at,
        row.terms_expires_at as string,
        row.org_id as string,
        row.policy_version as number,
        row.consent_revision as string,
        row.cap_minor as number,
        row.authorized_principal as string,
        row.org_id as string,
        row.consent_json as string,
      ],
    );
  }
  function abandonment(
    original: Command,
    reason: "expired" | "consent-withdrawn" | "not-needed" | "admission-accepted",
    at: string,
    observedVersion: number | null,
  ): readonly SqlStatement[] {
    const { row, admission } = original;
    return [
      {
        sql: `INSERT INTO stripe_billing_on_demand_abandonments (org_id, reference, exposure_ref, reason, observed_policy_version, decision_context_json, abandoned_at, cap_state, command_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'released', 'abandoned')`,
        params: [
          admission.organizationId,
          row.reference as string,
          row.exposure_ref as string,
          reason,
          observedVersion,
          canonicalJson({
            organizationId: admission.organizationId,
            reference: row.reference,
            decision: reason,
            admissionRef: admission.reference,
            admissionNamespace: admission.namespace,
            admissionFingerprint: admission.fingerprint,
          }),
          at,
        ],
      },
      {
        sql: "UPDATE org_wallet_cash_exposures SET status = 'released', source_ref = NULL, closed_at = ? WHERE org_id = ? AND ref = ? AND status = 'reserved' AND source_ref IS NULL",
        params: [at, admission.organizationId, row.exposure_ref as string],
      },
      {
        sql: "UPDATE stripe_billing_on_demand_commands SET state = 'abandoned' WHERE org_id = ? AND reference = ? AND state = 'prepared' AND dispatched_at IS NULL",
        params: [admission.organizationId, row.reference as string],
      },
    ];
  }
  async function maybeAbandon(original: Command, includeCapacity: boolean): Promise<Command> {
    if (original.row.state !== "prepared") return original;
    const at = now();
    let reason: "expired" | "consent-withdrawn" | "not-needed" | "admission-accepted" | null = null;
    let version: number | null = null;
    let conditions: readonly SqlStatement[] = [];
    if (at >= String(original.row.terms_expires_at)) reason = "expired";
    else {
      const policy = (
        await sql.query(
          "SELECT policy_version, on_limit, consent_revision FROM org_wallet_limit_policies WHERE org_id = ?",
          [original.admission.organizationId],
        )
      )[0];
      if (
        policy &&
        (policy.on_limit !== "on-demand" ||
          policy.policy_version !== original.row.policy_version ||
          policy.consent_revision !== original.row.consent_revision)
      ) {
        reason = "consent-withdrawn";
        version = positive(policy.policy_version, "unavailable");
      } else if (await accepted(original.admission)) {
        reason = "admission-accepted";
        const read = acceptedStatement(original.admission);
        conditions = guard(
          `EXISTS (SELECT 1 FROM (${read.sql}) accepted WHERE fingerprint = ? AND money_policy = 'usd-micros-v2')`,
          [...(read.params ?? []), original.admission.receiptFingerprint],
        );
      } else if (includeCapacity) {
        const funds = await capacity(original.admission, at);
        const snapshot = funds.decode(await sql.query(funds.statement.sql, funds.statement.params));
        if (!snapshot.refundReceivableBlocked && snapshot.deficitMicros === 0) {
          reason = "not-needed";
          conditions = guard(
            `EXISTS (SELECT 1 FROM (${funds.statement.sql}) capacity WHERE receivable_blocked = 0 AND deficit_micros = 0)`,
            funds.statement.params ?? [],
          );
        }
      }
    }
    if (reason !== null) {
      try {
        await sql.batch([...conditions, ...abandonment(original, reason, at, version)]);
      } catch {
        /* A concurrent first dispatch/receipt wins; read only its original state. */
      }
      const updated = await rowFor(
        original.admission.organizationId,
        String(original.row.reference),
      );
      if (!updated) fail("unavailable");
      return await command(updated);
    }
    return original;
  }

  async function pinIntent(original: Command, id: string): Promise<Command> {
    processorId(id, "pi_", "unavailable");
    try {
      await sql.run(
        "UPDATE stripe_billing_on_demand_commands SET payment_intent_id = ? WHERE org_id = ? AND reference = ? AND state = 'dispatched' AND payment_intent_id IS NULL",
        [id, original.row.org_id as string, original.row.reference as string],
      );
    } catch {
      /* Original readback, never a different native ID or another POST. */
    }
    const row = await rowFor(String(original.row.org_id), String(original.row.reference));
    if (!row || row.payment_intent_id !== id) fail("unavailable");
    return await command(row);
  }
  async function appendAttempt(original: Command, kind: "unknown-ack" | "readback"): Promise<void> {
    try {
      await sql.run(
        `INSERT INTO stripe_billing_on_demand_attempts (org_id, reference, sequence, kind, detail_json, created_at, first_dispatch_at)
        SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, NULL FROM stripe_billing_on_demand_attempts WHERE org_id = ? AND reference = ?`,
        [
          original.row.org_id as string,
          original.row.reference as string,
          kind,
          canonicalJson({ outcome: kind === "unknown-ack" ? "unavailable" : "requested" }),
          now(),
          original.row.org_id as string,
          original.row.reference as string,
        ],
      );
    } catch {
      /* Attempt diagnostics are sanitized and never replace source custody. */
    }
  }
  function metadataMatches(value: unknown, original: Command): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const metadata = value as Record<string, unknown>;
    return Object.entries(original.metadata).every(
      ([key, expected]) => Object.hasOwn(metadata, key) && metadata[key] === expected,
    );
  }
  function nativeTupleMatches(native: StripeBillingObject, original: Command): boolean {
    return (
      native.object === "payment_intent" &&
      native.livemode === false &&
      native.deleted !== true &&
      native.customer === original.row.customer_id &&
      native.payment_method === original.row.payment_method_id &&
      native.currency === "usd" &&
      native.amount === original.row.amount_minor &&
      native.invoice == null &&
      [
        "account",
        "application",
        "application_fee",
        "application_fee_amount",
        "on_behalf_of",
        "transfer_data",
        "transfer",
        "source_transfer",
        "destination",
      ].every((key) => native[key] == null) &&
      metadataMatches(native.metadata, original)
    );
  }
  async function recoverIntent(original: Command): Promise<StripeBillingObject | null> {
    const id = original.row.payment_intent_id;
    if (typeof id === "string")
      return await client.get("payment_intents", id, { expand: ["latest_charge"] });
    let cursor: string | undefined;
    let match: string | null = null;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < MAX_READBACK_PAGES; pageNumber++) {
      const page = await client.list("payment_intents", {
        customer: String(original.row.customer_id),
        createdGte: Math.floor(Date.parse(String(original.row.created_at)) / 1000),
        createdLte: Math.floor(Date.parse(now()) / 1000),
        limit: READBACK_PAGE_SIZE,
        ...(cursor === undefined ? {} : { startingAfter: cursor }),
      });
      if (
        !Array.isArray(page.data) ||
        typeof page.hasMore !== "boolean" ||
        page.data.length > READBACK_PAGE_SIZE
      )
        return null;
      for (const candidate of page.data) {
        if (seen.has(candidate.id)) return null;
        seen.add(candidate.id);
        if (metadataMatches(candidate.metadata, original)) {
          if (match !== null) return null;
          match = processorId(candidate.id, "pi_", "unavailable");
        }
      }
      if (!page.hasMore)
        return match === null
          ? null
          : await client.get("payment_intents", match, { expand: ["latest_charge"] });
      const next = page.data.at(-1)?.id;
      if (typeof next !== "string" || next === cursor) return null;
      cursor = next;
    }
    // An incomplete bounded list proves neither a unique original nor absence.
    return null;
  }
  async function closeCanceled(original: Command, native: StripeBillingObject): Promise<void> {
    if (
      native.object !== "payment_intent" ||
      native.id !== original.row.payment_intent_id ||
      native.livemode !== false ||
      native.deleted === true ||
      native.status !== "canceled" ||
      native.customer !== original.row.customer_id ||
      native.payment_method !== original.row.payment_method_id ||
      native.currency !== "usd" ||
      native.amount !== original.row.amount_minor ||
      native.amount_received !== 0 ||
      native.amount_capturable !== 0 ||
      native.latest_charge != null ||
      native.invoice != null ||
      [
        "account",
        "application",
        "application_fee",
        "application_fee_amount",
        "on_behalf_of",
        "transfer_data",
        "transfer",
        "source_transfer",
        "destination",
      ].some((key) => native[key] != null) ||
      !metadataMatches(native.metadata, original)
    )
      fail("unavailable");
    const at = now();
    if (at < String(original.row.dispatched_at)) fail("unavailable");
    const evidence = canonicalJson({
      kind: "stripe-on-demand-canceled",
      paymentIntentId: native.id,
      status: "canceled",
      amountReceivedMinor: 0,
      amountCapturableMinor: 0,
      latestChargeId: null,
    });
    await sql.batch([
      {
        sql: `INSERT INTO stripe_billing_on_demand_terminals
        (org_id, reference, payment_intent_id, charge_id, status, account_id, mode, billing_authority, customer_id, payment_method_id, currency, amount_minor, native_receipt_json, observed_at, exposure_ref, cap_terminal_state, command_terminal_state)
        VALUES (?, ?, ?, NULL, 'canceled', ?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?, 'released', 'canceled')`,
        params: [
          original.row.org_id as string,
          original.row.reference as string,
          native.id,
          original.row.account_id as string,
          original.row.mode as string,
          original.row.billing_authority as string,
          original.row.customer_id as string,
          original.row.payment_method_id as string,
          original.row.amount_minor as number,
          evidence,
          at,
          original.row.exposure_ref as string,
        ],
      },
      {
        sql: "UPDATE org_wallet_cash_exposures SET status = 'released', source_ref = ?, closed_at = ? WHERE org_id = ? AND ref = ? AND status = 'reserved'",
        params: [native.id, at, original.row.org_id as string, original.row.exposure_ref as string],
      },
      {
        sql: "UPDATE stripe_billing_on_demand_commands SET state = 'canceled' WHERE org_id = ? AND reference = ? AND state = 'dispatched' AND payment_intent_id = ?",
        params: [original.row.org_id as string, original.row.reference as string, native.id],
      },
    ]);
  }
  async function fundingProof(
    original: Command,
    native: StripeBillingObject,
  ): Promise<StripeOnDemandFundingProof> {
    const latest = native.latest_charge;
    const chargeId =
      typeof latest === "string"
        ? latest
        : latest && typeof latest === "object" && !Array.isArray(latest)
          ? (latest as Record<string, unknown>).id
          : null;
    processorId(chargeId, "ch_", "unavailable");
    const charge = await client.get("charges", chargeId as string);
    return verifyStripeOnDemandFunding(
      {
        organizationId: String(original.row.org_id),
        reference: String(original.row.reference),
        fingerprint: String(original.row.fingerprint),
        fundingRef: String(original.row.funding_ref),
        accountId: realm.accountId,
        mode: "test",
        financialRealm: realm.financialRealm,
        billingAuthority: realm.billingAuthority,
        customerId: String(original.row.customer_id),
        paymentMethodId: String(original.row.payment_method_id),
        paymentIntentId: native.id,
        chargeId: chargeId as string,
        currency: "USD",
        amountMinor: Number(original.row.amount_minor),
        observedAt: now(),
        metadata: original.metadata,
      },
      { paymentIntent: native, charge },
    );
  }
  async function originalForIntent(
    paymentIntentId: string,
  ): Promise<{ readonly original: Command; readonly native: StripeBillingObject } | null> {
    const id = processorId(paymentIntentId, "pi_", "invalid_argument");
    const native = await client.get("payment_intents", id, { expand: ["latest_charge"] });
    if (
      !native ||
      native.id !== id ||
      typeof native.metadata !== "object" ||
      native.metadata === null ||
      Array.isArray(native.metadata)
    )
      return null;
    const metadata = native.metadata as Record<string, unknown>;
    if (typeof metadata.organizationId !== "string" || typeof metadata.reference !== "string")
      return null;
    const row = await rowFor(metadata.organizationId, metadata.reference);
    if (!row) return null;
    let original = await command(row);
    assertOriginalRealm(original);
    if (
      original.row.state === "prepared" ||
      original.row.state === "abandoned" ||
      !nativeTupleMatches(native, original) ||
      (original.row.payment_intent_id !== null && original.row.payment_intent_id !== id)
    )
      return null;
    if (original.row.payment_intent_id === null) original = await pinIntent(original, id);
    return { original, native };
  }
  async function drain(original: Command): Promise<Command> {
    assertOriginalRealm(original);
    if (original.row.state === "prepared") return await maybeAbandon(original, false);
    if (original.row.state !== "dispatched") return original;
    await appendAttempt(original, "readback");
    try {
      const native = await recoverIntent(original);
      if (!native) return original;
      if (!nativeTupleMatches(native, original)) return original;
      original = await pinIntent(original, native.id);
      if (original.row.state !== "dispatched") return original;
      if (native.status === "canceled") await closeCanceled(original, native);
      else if (native.status === "succeeded") {
        const proof = await fundingProof(original, native);
        await store.grantOnDemand({
          organizationId: String(original.row.org_id),
          reference: String(original.row.reference),
          expectedCommandFingerprint: String(original.row.fingerprint),
          native: proof,
        });
      }
      // requires_action/failed/processing statuses never release exposure.
    } catch {
      // Unknown readback, failed native verification or lost store ACK: retain the
      // original command/cap; only its exact committed funding/terminal may win.
    }
    const row = await rowFor(String(original.row.org_id), String(original.row.reference));
    if (!row) fail("unavailable");
    return await command(row);
  }
  async function dispatch(original: Command): Promise<Command> {
    original = await maybeAbandon(original, true);
    if (original.row.state !== "prepared") return await drain(original);
    const at = now();
    const funds = await capacity(original.admission, at);
    const snapshot = funds.decode(await sql.query(funds.statement.sql, funds.statement.params));
    if (
      snapshot.refundReceivableBlocked ||
      snapshot.deficitMicros === null ||
      snapshot.deficitMicros === 0
    )
      return await maybeAbandon(original, true);
    // Reprice this exact deficit with the saved original rule. A changed quote
    // cannot resize or replace its immutable command or release its reservation.
    try {
      const calculation = calculateOrgOnDemandFunding(original.terms, {
        deficitMicros: String(snapshot.deficitMicros),
        evaluatedAt: at,
      });
      if (
        calculation.kind !== "single-charge" ||
        calculation.amountMinor !== original.row.amount_minor
      )
        fail("unavailable");
    } catch {
      fail("unavailable");
    }
    // Re-qualify the original selected card immediately before the durable marker.
    // This is never required for an already-dispatched original drain.
    await verifyStripeOnDemandCard(
      { sql, client, realm },
      {
        organizationId: original.admission.organizationId,
        customerId: String(original.row.customer_id),
        paymentMethodId: String(original.row.payment_method_id),
        verifiedAt: at,
        ...(original.row.setup_intent_id === null
          ? {}
          : { setupIntentId: String(original.row.setup_intent_id) }),
      },
    );
    const markerAt = now();
    const nonce = crypto.randomUUID();
    const source = await sourceGuard(original.admission, markerAt, snapshot.deficitMicros);
    try {
      await sql.batch([
        ...source,
        ...consentGuard(original, markerAt),
        {
          sql: `INSERT INTO stripe_billing_on_demand_attempts (org_id, reference, sequence, kind, detail_json, created_at, first_dispatch_at)
          VALUES (?, ?, 1, 'first-dispatch', ?, ?, ?)`,
          params: [
            original.row.org_id as string,
            original.row.reference as string,
            canonicalJson({ nonce }),
            markerAt,
            markerAt,
          ],
        },
        {
          sql: "UPDATE stripe_billing_on_demand_commands SET state = 'dispatched', dispatched_at = ? WHERE org_id = ? AND reference = ? AND state = 'prepared' AND dispatched_at IS NULL",
          params: [markerAt, original.row.org_id as string, original.row.reference as string],
        },
      ]);
    } catch {
      /* Own exact marker readback decides whether this invocation may POST. */
    }
    const row = await rowFor(String(original.row.org_id), String(original.row.reference));
    if (!row) fail("unavailable");
    original = await command(row);
    if (original.row.state !== "dispatched") return await maybeAbandon(original, true);
    const attempts = await sql.query(
      "SELECT detail_json FROM stripe_billing_on_demand_attempts WHERE org_id = ? AND reference = ? AND kind = 'first-dispatch'",
      [original.row.org_id as string, original.row.reference as string],
    );
    if (attempts.length !== 1 || attempts[0]?.detail_json !== canonicalJson({ nonce }))
      return await drain(original);
    const form: Record<string, string> = {
      currency: "usd",
      amount: String(original.row.amount_minor),
      customer: String(original.row.customer_id),
      payment_method: String(original.row.payment_method_id),
      "payment_method_types[0]": "card",
      off_session: "true",
      confirm: "true",
    };
    for (const [key, value] of Object.entries(original.metadata)) form[`metadata[${key}]`] = value;
    try {
      const native = await client.post("payment_intents", {
        form,
        idempotencyKey: String(original.row.stripe_key),
      });
      original = await pinIntent(original, native.id);
    } catch {
      await appendAttempt(original, "unknown-ack");
    }
    return await drain(original);
  }

  async function prepare(admission: OrgBillingFreshAdmissionOrigin): Promise<Command | null> {
    const reference = await cashReference(admission);
    const prior = await rowFor(admission.organizationId, reference);
    if (prior) {
      if (prior.fingerprint !== admission.fingerprint) fail("reference_conflict");
      return await command(prior);
    }
    if (await accepted(admission)) return null;
    if (
      !Number.isSafeInteger(admission.amountMicros) ||
      admission.amountMicros < 0 ||
      !DIGEST.test(admission.fingerprint)
    )
      fail("invalid_argument");
    if (admission.amountMicros === 0) return null;
    if (
      admission.allocationAdmission.onLimit !== "on-demand" ||
      admission.allocationAdmission.allowPurchasedCredit !== true
    )
      fail("consent_required");
    const at = now();
    const consent = await readOrgOnDemandConsent({
      sql,
      organizationId: admission.organizationId,
      policyVersion: admission.allocationAdmission.policyVersion,
    });
    if (
      !consent ||
      consent.selectedCardProof.organizationId !== admission.organizationId ||
      consent.publicResult.consentRevision !== admission.allocationAdmission.consentRevision ||
      canonicalJson(consent.acceptedTerms) !== canonicalJson(terms)
    )
      fail("consent_required");
    const card = consent.selectedCardProof;
    if (
      card.accountId !== realm.accountId ||
      card.mode !== realm.mode ||
      card.financialRealm !== realm.financialRealm ||
      card.billingAuthority !== realm.billingAuthority
    )
      fail("unqualified_origin");
    const funds = await capacity(admission, at);
    const snapshot = funds.decode(await sql.query(funds.statement.sql, funds.statement.params));
    if (snapshot.refundReceivableBlocked || snapshot.deficitMicros === null) fail("unavailable");
    if (snapshot.deficitMicros === 0) return null;
    const calculation = calculateOrgOnDemandFunding(terms, {
      deficitMicros: String(snapshot.deficitMicros),
      evaluatedAt: at,
    });
    if (calculation.kind === "none") return null;
    // Only checks that the original duration is representable for preparation;
    // the common store still chooses first verified funding and its expiry once.
    resolveOrgOnDemandCreditExpiry(terms, at);
    const reservation = await exposures.prepareReservation(
      {
        organizationId: admission.organizationId,
        reference,
        policyVersion: consent.policyVersion,
        consentRevision: terms.consentRevision,
        amountMinor: calculation.amountMinor,
      },
      at,
    );
    if (reservation.replay) fail("unavailable");
    const period = orgCashCapPeriod(at);
    const deadline =
      terms.validity.validUntil < period.periodEnd ? terms.validity.validUntil : period.periodEnd;
    if (deadline <= at) fail("consent_required");
    const fundingRef = `ondemand:${reference.slice(9)}`;
    const stripeKey = `takoserver:org-on-demand:${reference.slice(9)}`;
    const envelope = parseStripeOnDemandConsentEnvelope({
      kind: consent.kind,
      version: consent.version,
      publicResult: consent.publicResult,
      policyVersion: consent.policyVersion,
      authorizedPrincipal: consent.authorizedPrincipal,
      acceptedAt: consent.acceptedAt,
      acceptedTerms: consent.acceptedTerms,
      selectedCardProof: consent.selectedCardProof,
    });
    const metadata: StripeOnDemandOriginalMetadata = Object.freeze({
      organizationId: admission.organizationId,
      reference,
      fingerprint: admission.fingerprint,
      fundingRef,
      stripeAccountId: realm.accountId,
      financialRealm: realm.financialRealm,
      billingAuthority: realm.billingAuthority,
    });
    const request = {
      currency: "usd",
      amount: calculation.amountMinor,
      customer: card.customerId,
      payment_method: card.paymentMethodId,
      payment_method_types: ["card"],
      off_session: true,
      confirm: true,
      metadata,
    };
    const consentJson = canonicalJson(envelope);
    const candidate: Row = {
      org_id: admission.organizationId,
      reference,
      admission_json: canonicalJson(admission),
      exposure_ref: reference,
      funding_ref: fundingRef,
      fingerprint: admission.fingerprint,
      account_id: realm.accountId,
      mode: realm.mode,
      billing_authority: realm.billingAuthority,
      customer_id: card.customerId,
      payment_method_id: card.paymentMethodId,
      setup_intent_id: card.setupIntentId,
      authorized_principal: consent.authorizedPrincipal,
      consent_revision: terms.consentRevision,
      terms_revision: terms.termsRevision,
      terms_json: canonicalJson(terms),
      consent_json: consentJson,
      request_json: canonicalJson(request),
      policy_version: consent.policyVersion,
      cap_minor: consent.publicResult.cashCapMinor,
      period_start: period.periodStart,
      period_end: period.periodEnd,
      amount_minor: calculation.amountMinor,
      credit_expiry_kind: terms.purchaseCreditExpiry.kind,
      credit_expiry_seconds:
        terms.purchaseCreditExpiry.kind === "none" ? null : terms.purchaseCreditExpiry.seconds,
      terms_expires_at: deadline,
      stripe_key: stripeKey,
      state: "prepared",
      dispatched_at: null,
      payment_intent_id: null,
      created_at: at,
    };
    const original = await command(candidate);
    const source = await sourceGuard(admission, at, snapshot.deficitMicros);
    const columns = Object.keys(candidate);
    try {
      await sql.batch([
        ...source,
        ...consentGuard(original, at),
        ...reservation.statements,
        {
          sql: `INSERT INTO stripe_billing_on_demand_commands (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          params: columns.map((key) => candidate[key] as SqlParam),
        },
      ]);
    } catch {
      const committed = await rowFor(admission.organizationId, reference);
      if (committed) {
        if (committed.fingerprint !== admission.fingerprint) fail("reference_conflict");
        return await command(committed);
      }
      if (await accepted(admission)) return null;
      fail("unavailable");
    }
    const committed = await rowFor(admission.organizationId, reference);
    if (!committed) fail("unavailable");
    return await command(committed);
  }
  const service: StripeOnDemandService = Object.freeze({
    terms,
    readTerms() {
      return terms;
    },
    async verifyConsent(input: Parameters<StripeOnDemandService["verifyConsent"]>[0]) {
      const hasSetup =
        typeof input === "object" && input !== null && Object.hasOwn(input, "setupIntentId");
      const keys = [
        "organizationId",
        "authorizedPrincipal",
        "termsRevision",
        "consentRevision",
        "cashCapMinor",
        "paymentMethodId",
        ...(hasSetup ? ["setupIntentId"] : []),
      ];
      exact(input, keys, "invalid_argument");
      const org = identifier(input.organizationId, "invalid_argument");
      text(input.authorizedPrincipal, 512, "invalid_argument");
      if (
        input.termsRevision !== terms.termsRevision ||
        input.consentRevision !== terms.consentRevision
      )
        fail("consent_required");
      validateOrgOnDemandCashCap(terms, input.cashCapMinor);
      const verifiedAt = now();
      calculateOrgOnDemandFunding(terms, { deficitMicros: "0", evaluatedAt: verifiedAt });
      const customers = await sql.query(
        "SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?",
        [org],
      );
      if (customers.length !== 1) fail("consent_required");
      const customerId = processorId(customers[0]?.customer_id, "cus_", "consent_required");
      const selectedCardProof = await verifyStripeOnDemandCard(
        { sql, client, realm },
        {
          organizationId: org,
          customerId,
          paymentMethodId: input.paymentMethodId,
          verifiedAt,
          ...(input.setupIntentId === undefined ? {} : { setupIntentId: input.setupIntentId }),
        },
      );
      return Object.freeze({ acceptedTerms: terms, selectedCardProof });
    },
    async beforeNewAdmission(token: unknown) {
      assertStripeOnDemandService(service, context);
      const admission = readOrgBillingFreshAdmissionOrigin(token, { sql, clock, billingConfig });
      if (admission.namespace !== "org-hold" && admission.namespace !== "org-usage")
        fail("unqualified_origin");
      let original: Command | null;
      try {
        original = await prepare(admission);
      } catch (error) {
        if (
          error instanceof OrgOnDemandTermsError &&
          (error.code === "maximum_charge_exceeded" || error.code === "terms_not_valid")
        )
          return Object.freeze({ state: "refused", receipt: null });
        throw error;
      }
      if (!original) return Object.freeze({ state: "covered" });
      assertOriginalRealm(original);
      if (original.row.state === "prepared") original = await dispatch(original);
      else if (original.row.state === "dispatched") original = await drain(original);
      const current = receipt(original);
      if (current.state === "abandoned") {
        const decision = (
          await sql.query(
            "SELECT reason FROM stripe_billing_on_demand_abandonments WHERE org_id = ? AND reference = ?",
            [current.organizationId, current.reference],
          )
        )[0]?.reason;
        if (decision === "not-needed" || decision === "admission-accepted")
          return Object.freeze({ state: "covered" });
      }
      return Object.freeze({
        state:
          current.state === "funded"
            ? "funded"
            : current.state === "pending" || current.state === "prepared"
              ? "pending"
              : "refused",
        receipt: current,
      });
    },
    async readOriginal(input: { readonly organizationId: string; readonly reference: string }) {
      exact(input, ["organizationId", "reference"], "invalid_argument");
      const row = await rowFor(
        identifier(input.organizationId, "invalid_argument"),
        identifier(input.reference, "invalid_argument"),
      );
      return row ? receipt(await command(row)) : null;
    },
    async drainOriginal(input: { readonly organizationId: string; readonly reference: string }) {
      exact(input, ["organizationId", "reference"], "invalid_argument");
      const row = await rowFor(
        identifier(input.organizationId, "invalid_argument"),
        identifier(input.reference, "invalid_argument"),
      );
      return row ? receipt(await drain(await command(row))) : null;
    },
    async drainForPaymentIntent(paymentIntentId: string) {
      const found = await originalForIntent(paymentIntentId);
      return found ? receipt(await drain(found.original)) : null;
    },
    async readFundingProofForPaymentIntent(paymentIntentId: string) {
      const found = await originalForIntent(paymentIntentId);
      return found && found.native.status === "succeeded"
        ? await fundingProof(found.original, found.native)
        : null;
    },
    async drainPending(limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_argument");
      const rows = await sql.query(
        `SELECT c.* FROM stripe_billing_on_demand_commands c WHERE c.state = 'dispatched' OR (c.state = 'prepared' AND c.terms_expires_at <= ?)
        ORDER BY (SELECT COUNT(*) FROM stripe_billing_on_demand_attempts a WHERE a.org_id=c.org_id AND a.reference=c.reference AND a.kind='readback'), c.created_at, c.org_id, c.reference LIMIT ?`,
        [now(), limit],
      );
      const receipts: StripeOnDemandReceipt[] = [];
      for (const row of rows) receipts.push(receipt(await drain(await command(row))));
      return Object.freeze(receipts);
    },
    prepareWithdrawalStatements(input: {
      readonly organizationId: string;
      readonly fromVersion: number;
      readonly toVersion: number;
      readonly instant: string;
    }) {
      exact(input, ["organizationId", "fromVersion", "toVersion", "instant"], "invalid_argument");
      const org = identifier(input.organizationId, "invalid_argument");
      const from = positive(input.fromVersion, "invalid_argument");
      const to = positive(input.toVersion, "invalid_argument");
      if (!Number.isSafeInteger(from + 1) || to !== from + 1) fail("invalid_argument");
      const at = instant(input.instant, "invalid_argument");
      return Object.freeze([
        ...guard(
          "EXISTS (SELECT 1 FROM org_wallet_limit_policies WHERE org_id = ? AND policy_version = ? AND on_limit = 'stop')",
          [org, to],
        ),
        {
          sql: `INSERT INTO stripe_billing_on_demand_abandonments (org_id, reference, exposure_ref, reason, observed_policy_version, decision_context_json, abandoned_at, cap_state, command_state)
          SELECT c.org_id, c.reference, c.exposure_ref, 'consent-withdrawn', ?,
            json_object('organizationId', c.org_id, 'reference', c.reference, 'decision', 'consent-withdrawn', 'admissionRef', json_extract(c.admission_json,'$.reference'), 'admissionNamespace',json_extract(c.admission_json,'$.namespace'), 'admissionFingerprint',json_extract(c.admission_json,'$.fingerprint')), ?, 'released', 'abandoned'
          FROM stripe_billing_on_demand_commands c JOIN org_wallet_cash_exposures e ON e.org_id=c.org_id AND e.ref=c.exposure_ref
          WHERE c.org_id = ? AND c.policy_version = ? AND c.state = 'prepared' AND c.dispatched_at IS NULL AND c.payment_intent_id IS NULL AND c.created_at <= ?
            AND e.status = 'reserved' AND e.source_ref IS NULL
            AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_attempts a WHERE a.org_id=c.org_id AND a.reference=c.reference)
            AND NOT EXISTS (SELECT 1 FROM stripe_billing_on_demand_terminals t WHERE t.org_id=c.org_id AND t.reference=c.reference)`,
          params: [to, at, org, from, at],
        },
        {
          sql: `UPDATE org_wallet_cash_exposures SET status = 'released', source_ref = NULL, closed_at = ? WHERE org_id = ? AND status = 'reserved' AND source_ref IS NULL AND EXISTS
          (SELECT 1 FROM stripe_billing_on_demand_abandonments a WHERE a.org_id=org_wallet_cash_exposures.org_id AND a.exposure_ref=org_wallet_cash_exposures.ref AND a.reason='consent-withdrawn' AND a.observed_policy_version=? AND a.abandoned_at=?)`,
          params: [at, org, to, at],
        },
        {
          sql: `UPDATE stripe_billing_on_demand_commands SET state = 'abandoned' WHERE org_id = ? AND policy_version = ? AND state = 'prepared' AND dispatched_at IS NULL AND EXISTS
          (SELECT 1 FROM stripe_billing_on_demand_abandonments a WHERE a.org_id=stripe_billing_on_demand_commands.org_id AND a.reference=stripe_billing_on_demand_commands.reference AND a.reason='consent-withdrawn' AND a.observed_policy_version=? AND a.abandoned_at=?)`,
          params: [org, from, to, at],
        },
      ]);
    },
  });
  origins.set(service, { ...context, configJson: canonicalJson(billingConfig) });
  return service;
}
