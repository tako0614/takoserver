import { canonicalJson } from "./json.ts";
import { MoneyError, minorToMicros, parseUnsignedMicros } from "./money.ts";
import type { OrgUsageSummary } from "./org-usage-summary.ts";
import {
  type Clock,
  type Row,
  type Sql,
  SqlError,
  type SqlParam,
  type SqlStatement,
} from "./ports.ts";

export type OrgOnLimit = "stop" | "prepaid" | "postpaid" | "on-demand";

/** The enum is broader than the qualified execution capability. */
export const ORG_LIMIT_CAPABILITIES = Object.freeze({
  stop: true,
  prepaid: true,
  postpaid: false,
  "on-demand": false,
});
export const PREPAID_CONSENT_REVISION = "prepaid-usage-v1";

export class OrgLimitPolicyError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "OrgLimitPolicyError";
  }
}

export interface OrgLimitPolicyView {
  readonly onLimit: OrgOnLimit;
  readonly capabilities: typeof ORG_LIMIT_CAPABILITIES;
  readonly consentRevision: string | null;
  readonly cashCapMinor: number | null;
  /** UTC cash-cap month, independently of the allowance's invoice period. */
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface ChangeOrgLimitPolicy {
  readonly organizationId: string;
  /** Canonical authenticated actor kind + exact payment principal, supplied by control. */
  readonly authorizedPrincipal: string;
  readonly reference: string;
  readonly onLimit: OrgOnLimit;
  readonly cashCapMinor?: number;
  readonly consentRevision?: string;
}

export interface OrgLimitAdmission {
  readonly onLimit: "stop" | "prepaid";
  readonly policyVersion: number;
  readonly consentRevision: string | null;
  readonly allowPurchasedCredit: boolean;
  /** Include both statements in the same atomic batch as the new debit/hold. */
  readonly guard: SqlStatement;
  readonly cleanup: SqlStatement;
}

export interface OrgUsageWarning {
  readonly organizationId: string;
  readonly periodKind: "free" | "paid";
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly thresholdBasisPoints: 8000 | 9500;
  readonly effectiveIncludedMicros: string;
  readonly usedMicros: string;
  readonly heldMicros: string;
  readonly nextResetAt: string;
}

export interface OrgUsageWarningTransport {
  /** Must deduplicate this immutable key across retries, including a lost ACK. */
  deliver(
    warning: OrgUsageWarning,
    idempotencyKey: string,
  ): Promise<{ readonly deliveryReference: string }>;
}

export interface OrgLimitPolicy {
  read(organizationId: string): Promise<OrgLimitPolicyView>;
  change(input: ChangeOrgLimitPolicy): Promise<OrgLimitPolicyView>;
  prepareAdmission(organizationId: string): Promise<OrgLimitAdmission>;
  observeUsageSummary(summary: OrgUsageSummary): Promise<void>;
  /** Append after allocation/settlement in the same atomic money batch. */
  warningStatements(input: {
    readonly organizationId: string;
    readonly instant: string;
    readonly summaryRead: SqlStatement;
  }): readonly SqlStatement[];
  /** Resolve the transport before calling this; absence is an explicit failure before any claim. */
  dispatchWarnings(transport: OrgUsageWarningTransport, limit?: number): Promise<number>;
}

export async function assertOrgLimitPolicySchema(sql: Sql): Promise<void> {
  const tables = await sql.query(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN
    ('org_wallet_limit_policies', 'org_wallet_limit_policy_commands', 'org_wallet_cash_cap_buckets',
      'org_wallet_cash_exposures', 'org_wallet_usage_warnings')`);
  if (tables.length !== 5) fail("billing_schema_not_ready", 503);
  const columns: Record<string, readonly string[]> = {
    org_wallet_limit_policies: [
      "policy_version",
      "on_limit",
      "consent_revision",
      "cash_cap_minor",
      "authorized_principal",
    ],
    org_wallet_limit_policy_commands: ["authorized_principal", "fingerprint", "result_json"],
    org_wallet_cash_cap_buckets: ["period_start", "period_end"],
    org_wallet_cash_exposures: [
      "period_start",
      "period_end",
      "policy_version",
      "consent_revision",
      "amount_minor",
      "status",
      "source_ref",
    ],
    org_wallet_usage_warnings: [
      "payload_json",
      "threshold_basis_points",
      "claim_token",
      "claim_until",
      "delivered_at",
    ],
  };
  for (const [table, required] of Object.entries(columns)) {
    const present = new Set(
      (await sql.query(`PRAGMA table_info(${table})`)).map((row) => row.name),
    );
    if (required.some((column) => !present.has(column))) fail("billing_schema_not_ready", 503);
  }
  const durableObjects = await sql.query(`SELECT name FROM sqlite_schema WHERE
    (type = 'trigger' AND name IN ('org_wallet_limit_policy_version', 'org_wallet_limit_policies_no_delete',
      'org_wallet_limit_policy_commands_no_update', 'org_wallet_limit_policy_commands_no_delete',
      'org_wallet_cash_cap_buckets_no_update', 'org_wallet_cash_cap_buckets_no_delete',
      'org_wallet_cash_exposures_bucket_insert', 'org_wallet_cash_exposures_immutable', 'org_wallet_cash_exposures_no_delete',
      'org_wallet_usage_warnings_immutable', 'org_wallet_usage_warnings_no_delete'))
    OR (type = 'index' AND name = 'org_wallet_cash_exposures_paid_source')`);
  if (durableObjects.length !== 12) fail("billing_schema_not_ready", 503);
}

function fail(code: string, status: number): never {
  throw new OrgLimitPolicyError(code, status);
}

function reference(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value))
    fail("invalid_reference", 400);
}

function principal(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    fail("invalid_payment_principal", 400);
}

function instant(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("billing_policy_unavailable", 503);
}

function safeAmount(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail("billing_policy_unavailable", 503);
}

function cashAmount(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    fail("invalid_cash_cap", 400);
  try {
    minorToMicros(value);
  } catch (error) {
    if (error instanceof MoneyError) fail("invalid_cash_cap", 400);
    throw error;
  }
}

export function orgCashCapPeriod(value: string): {
  readonly periodStart: string;
  readonly periodEnd: string;
} {
  instant(value);
  const periodStart = `${value.slice(0, 7)}-01T00:00:00.000Z`;
  const end = new Date(periodStart);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const periodEnd = end.toISOString();
  instant(periodEnd);
  return { periodStart, periodEnd };
}

function guard(id: string, condition: string, params: readonly SqlParam[]): SqlStatement {
  return {
    sql: `INSERT INTO wallet_allocation_guards (id, valid) VALUES (?, CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
    params: [id, ...params],
  };
}

function cleanup(id: string): SqlStatement {
  return { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [id] };
}

function view(row: Row | undefined, at: string): OrgLimitPolicyView {
  if (row) {
    safeAmount(row.policy_version);
    if (row.policy_version < 1) fail("billing_policy_unavailable", 503);
    // An unsupported stored mode is a conformance gap, never a silent stop/prepaid fallback.
    if (row.on_limit !== "stop" && row.on_limit !== "prepaid") fail("limit_mode_unavailable", 409);
    if (
      row.cash_cap_minor !== null ||
      (row.on_limit === "stop" && row.consent_revision !== null) ||
      (row.on_limit === "prepaid" && row.consent_revision !== PREPAID_CONSENT_REVISION)
    )
      fail("billing_policy_unavailable", 503);
  }
  return {
    onLimit: row?.on_limit === "prepaid" ? "prepaid" : "stop",
    capabilities: ORG_LIMIT_CAPABILITIES,
    consentRevision: row ? (row.consent_revision as string | null) : null,
    cashCapMinor: null,
    ...orgCashCapPeriod(at),
  };
}

function validateCommand(input: ChangeOrgLimitPolicy): void {
  reference(input.organizationId);
  reference(input.reference);
  principal(input.authorizedPrincipal);
  const allowed = new Set([
    "organizationId",
    "authorizedPrincipal",
    "reference",
    "onLimit",
    "cashCapMinor",
    "consentRevision",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) fail("invalid_limit_policy", 400);
  if (!["stop", "prepaid", "postpaid", "on-demand"].includes(input.onLimit))
    fail("invalid_limit_policy", 400);
  if (input.onLimit === "stop" || input.onLimit === "prepaid") {
    if ("cashCapMinor" in input || "consentRevision" in input) fail("invalid_limit_policy", 400);
  } else {
    cashAmount(input.cashCapMinor);
    principal(input.consentRevision);
  }
}

/** Hosted composition opts into this policy; independent/self-host legacy wallets do not. */
export function createOrgLimitPolicy(input: {
  readonly sql: Sql;
  readonly clock?: Clock;
}): OrgLimitPolicy {
  const { sql, clock = () => new Date() } = input;
  const now = () => {
    const value = clock().toISOString();
    instant(value);
    return value;
  };
  const policy = async (org: string) =>
    (await sql.query("SELECT * FROM org_wallet_limit_policies WHERE org_id = ?", [org]))[0];
  const command = async (org: string, ref: string, fingerprint: string) => {
    const row = (
      await sql.query(
        "SELECT fingerprint, result_json FROM org_wallet_limit_policy_commands WHERE org_id = ? AND ref = ?",
        [org, ref],
      )
    )[0];
    if (!row) return null;
    if (row.fingerprint !== fingerprint) fail("reference_conflict", 409);
    try {
      return JSON.parse(String(row.result_json)) as OrgLimitPolicyView;
    } catch {
      return fail("billing_policy_unavailable", 503);
    }
  };

  return {
    async read(org) {
      reference(org);
      return view(await policy(org), now());
    },
    async change(change) {
      validateCommand(change);
      const org = change.organizationId;
      const fingerprint = canonicalJson(change);
      const replay = await command(org, change.reference, fingerprint);
      if (replay) return replay;
      if (!ORG_LIMIT_CAPABILITIES[change.onLimit]) fail("limit_mode_unavailable", 409);
      // No card lookup: the prepaid command itself records explicit spending consent.
      const at = now();
      const original = await policy(org);
      const originalVersion = original ? Number(original.policy_version) : 0;
      safeAmount(originalVersion);
      if (originalVersion === Number.MAX_SAFE_INTEGER) fail("billing_policy_unavailable", 503);
      const version = originalVersion + 1;
      const consent = change.onLimit === "prepaid" ? PREPAID_CONSENT_REVISION : null;
      const result: OrgLimitPolicyView = {
        onLimit: change.onLimit,
        capabilities: ORG_LIMIT_CAPABILITIES,
        consentRevision: consent,
        cashCapMinor: null,
        ...orgCashCapPeriod(at),
      };
      const id = `guard_${crypto.randomUUID()}`;
      const statements: SqlStatement[] = [
        guard(
          id,
          `COALESCE((SELECT policy_version FROM org_wallet_limit_policies WHERE org_id = ?), 0) = ?
            AND NOT EXISTS (SELECT 1 FROM org_wallet_cash_exposures WHERE org_id = ? AND status = 'reserved')`,
          [org, originalVersion, org],
        ),
        {
          sql: "INSERT INTO org_wallet_limit_policy_commands (org_id, ref, authorized_principal, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          params: [
            org,
            change.reference,
            change.authorizedPrincipal,
            fingerprint,
            canonicalJson(result),
            at,
          ],
        },
        {
          sql: `INSERT INTO org_wallet_limit_policies (org_id, on_limit, policy_version, consent_revision, cash_cap_minor, authorized_principal, updated_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT (org_id) DO UPDATE SET on_limit = excluded.on_limit,
            policy_version = excluded.policy_version, consent_revision = excluded.consent_revision,
            cash_cap_minor = excluded.cash_cap_minor, authorized_principal = excluded.authorized_principal,
            updated_at = excluded.updated_at`,
          params: [org, change.onLimit, version, consent, change.authorizedPrincipal, at],
        },
        cleanup(id),
      ];
      try {
        await sql.batch(statements);
      } catch (error) {
        if (!(error instanceof SqlError)) throw error;
        const committed = await command(org, change.reference, fingerprint);
        if (committed) return committed;
        if (error.code === "constraint") fail("limit_policy_conflict", 409);
        fail("billing_policy_unavailable", 503);
      }
      return result;
    },
    async prepareAdmission(org) {
      reference(org);
      const row = await policy(org);
      const current = view(row, now());
      const version = row ? Number(row.policy_version) : 0;
      const id = `guard_${crypto.randomUUID()}`;
      return {
        onLimit: current.onLimit as "stop" | "prepaid",
        policyVersion: version,
        consentRevision: current.consentRevision,
        allowPurchasedCredit: current.onLimit === "prepaid",
        guard: guard(
          id,
          "COALESCE((SELECT policy_version FROM org_wallet_limit_policies WHERE org_id = ?), 0) = ?",
          [org, version],
        ),
        cleanup: cleanup(id),
      };
    },
    async observeUsageSummary(summary) {
      const warnings = usageWarnings(summary);
      if (!warnings.length) return;
      const at = now();
      await sql.batch(
        warnings.map((warning) => ({
          sql: `INSERT INTO org_wallet_usage_warnings
          (org_id, period_start, period_end, threshold_basis_points, payload_json, state, claim_token, claim_until, created_at, delivered_at)
          VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)
          ON CONFLICT (org_id, period_start, period_end, threshold_basis_points) DO NOTHING`,
          params: [
            warning.organizationId,
            warning.periodStart,
            warning.periodEnd,
            warning.thresholdBasisPoints,
            canonicalJson(warning),
            at,
          ],
        })),
      );
    },
    warningStatements: prepareUsageWarningStatements,
    async dispatchWarnings(transport, limit = 20) {
      // Resolve a concrete transport before querying or claiming. No optional no-op callback.
      if (!transport || typeof transport.deliver !== "function")
        fail("warning_transport_unavailable", 503);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail("invalid_limit", 400);
      const at = now();
      const due = await sql.query(
        `SELECT * FROM org_wallet_usage_warnings WHERE state = 'pending'
          OR (state = 'dispatching' AND claim_until <= ?)
          ORDER BY created_at, org_id, period_start, threshold_basis_points LIMIT ?`,
        [at, limit],
      );
      let delivered = 0;
      for (const row of due) {
        const warning = decodeWarning(row);
        const token = `warning_${crypto.randomUUID()}`;
        const claimedAt = now();
        const until = new Date(Date.parse(claimedAt) + 60_000).toISOString();
        const keyParams = [
          warning.organizationId,
          warning.periodStart,
          warning.periodEnd,
          warning.thresholdBasisPoints,
        ];
        const claim = await sql.run(
          `UPDATE org_wallet_usage_warnings SET state = 'dispatching', claim_token = ?, claim_until = ?
          WHERE org_id = ? AND period_start = ? AND period_end = ? AND threshold_basis_points = ?
            AND (state = 'pending' OR (state = 'dispatching' AND claim_until <= ?))`,
          [token, until, ...keyParams, claimedAt],
        );
        if (claim.changes !== 1) continue;
        const acknowledgement = await transport.deliver(warning, warningKey(warning));
        if (
          !acknowledgement ||
          typeof acknowledgement.deliveryReference !== "string" ||
          !acknowledgement.deliveryReference
        )
          fail("warning_delivery_unacknowledged", 503);
        const finished = await sql.run(
          `UPDATE org_wallet_usage_warnings SET state = 'delivered', claim_token = NULL, claim_until = NULL, delivered_at = ?
          WHERE org_id = ? AND period_start = ? AND period_end = ? AND threshold_basis_points = ?
            AND state = 'dispatching' AND claim_token = ?`,
          [now(), ...keyParams, token],
        );
        if (finished.changes === 1) delivered += 1;
      }
      return delivered;
    },
  };
}

/**
 * Read the post-mutation entitlement inside the caller's batch. In particular,
 * a hold which crosses 80% and is released before the next GET still records
 * the original warning. A missing current grant during old-period terminal
 * settlement does not manufacture an entitlement or block that settlement.
 */
function prepareUsageWarningStatements(input: {
  readonly organizationId: string;
  readonly instant: string;
  readonly summaryRead: SqlStatement;
}): readonly SqlStatement[] {
  reference(input.organizationId);
  instant(input.instant);
  const period = orgCashCapPeriod(input.instant);
  const freeRef = `free:${input.organizationId}:${input.instant.slice(0, 7)}`;
  const params = input.summaryRead.params ?? [];
  if (params.length + 5 > 100) fail("billing_policy_unavailable", 503);
  return [
    {
      sql: `WITH raw_summary AS (${input.summaryRead.sql}),
      warning_context AS (SELECT ? AS org, ? AS month_start, ? AS month_end, ? AS free_ref, ? AS instant),
      entitlement AS (
        SELECT r.*, c.instant,
          CASE WHEN paid_count = 1 THEN paid_amount ELSE snapshot_amount END AS original,
          CASE WHEN paid_count = 1 THEN paid_revoked ELSE 0 END AS revoked,
          CASE WHEN paid_count = 1 THEN paid_start ELSE month_start END AS period_start,
          CASE WHEN paid_count = 1 THEN paid_end ELSE month_end END AS period_end,
          CASE WHEN paid_count = 1 THEN 'paid' ELSE 'free' END AS period_kind
        FROM raw_summary r CROSS JOIN warning_context c
        WHERE (SELECT COUNT(*) FROM raw_summary) = 1
          AND org_id = c.org AND snapshot_ref = c.free_ref AND snapshot_policy = 'usd-micros-v2'
          AND typeof(paid_count) = 'integer' AND paid_count IN (0, 1) AND pending_fence = 0
          AND typeof(snapshot_amount) = 'integer' AND snapshot_amount BETWEEN 0 AND 9007199254740991
          AND snapshot_amount = tariff_amount AND snapshot_revision = tariff_revision
          AND snapshot_end = month_end AND tariff_end = month_end
          AND (additional_min IS NULL OR (typeof(additional_min) = 'integer' AND additional_min >= 0))
          AND typeof(purchased_available) = 'integer' AND purchased_available BETWEEN 0 AND 9007199254740991
          AND typeof(direct_available) = 'integer' AND direct_available BETWEEN 0 AND 9007199254740991
          AND (paid_count = 0 OR (paid_kind = 'plan-included' AND paid_class = 'subscription' AND typeof(paid_ref) = 'text'))
      ),
      checked AS (
        SELECT *, original - revoked AS net FROM entitlement
        WHERE typeof(original) = 'integer' AND original BETWEEN 0 AND 9007199254740991
          AND typeof(revoked) = 'integer' AND revoked BETWEEN 0 AND original
          AND typeof(used_micros) = 'integer' AND used_micros BETWEEN 0 AND original
          AND typeof(held_micros) = 'integer' AND held_micros BETWEEN 0 AND original - used_micros
          AND period_start <= instant AND period_end > instant AND period_start < period_end
          AND strftime('%Y-%m-%dT%H:%M:%fZ', period_start) = period_start
          AND strftime('%Y-%m-%dT%H:%M:%fZ', period_end) = period_end
          AND ((original = 0 AND lot_amount IS NULL) OR
            (original > 0 AND lot_kind = 'plan-included' AND lot_amount = original AND lot_end = period_end
              AND lot_class = CASE WHEN paid_count = 1 THEN 'subscription' ELSE 'free' END))
      ),
      thresholds(basis_points, numerator, denominator) AS (VALUES (8000, 4, 5), (9500, 19, 20))
      INSERT INTO org_wallet_usage_warnings
        (org_id, period_start, period_end, threshold_basis_points, payload_json, state,
         claim_token, claim_until, created_at, delivered_at)
      SELECT org_id, period_start, period_end, basis_points,
        json_object('organizationId', org_id, 'periodKind', period_kind,
          'periodStart', period_start, 'periodEnd', period_end, 'thresholdBasisPoints', basis_points,
          'effectiveIncludedMicros', CAST(net AS TEXT), 'usedMicros', CAST(used_micros AS TEXT),
          'heldMicros', CAST(held_micros AS TEXT), 'nextResetAt', period_end),
        'pending', NULL, NULL, instant, NULL
      FROM checked CROSS JOIN thresholds
      WHERE net > 0 AND used_micros + held_micros >=
        (net / denominator) * numerator + ((net % denominator) * numerator + denominator - 1) / denominator
      ON CONFLICT (org_id, period_start, period_end, threshold_basis_points) DO NOTHING`,
      params: [
        ...params,
        input.organizationId,
        period.periodStart,
        period.periodEnd,
        freeRef,
        input.instant,
      ],
    },
  ];
}

function usageWarnings(summary: OrgUsageSummary): OrgUsageWarning[] {
  if (summary.currency !== "USD" || summary.unit !== "USD-micros")
    fail("billing_policy_unavailable", 503);
  reference(summary.organizationId);
  instant(summary.periodStart);
  instant(summary.periodEnd);
  instant(summary.nextResetAt);
  if (summary.periodStart >= summary.periodEnd || !["free", "paid"].includes(summary.periodKind))
    fail("billing_policy_unavailable", 503);
  safeAmount(summary.effectiveIncludedMicros);
  safeAmount(summary.usedMicros);
  safeAmount(summary.heldMicros);
  if (summary.effectiveIncludedMicros === 0) return [];
  const exposure = BigInt(summary.usedMicros) + BigInt(summary.heldMicros);
  if (exposure > BigInt(Number.MAX_SAFE_INTEGER)) fail("billing_policy_unavailable", 503);
  return ([8000, 9500] as const)
    .filter(
      (threshold) =>
        exposure * 10_000n >= BigInt(summary.effectiveIncludedMicros) * BigInt(threshold),
    )
    .map((thresholdBasisPoints) => ({
      organizationId: summary.organizationId,
      periodKind: summary.periodKind,
      periodStart: summary.periodStart,
      periodEnd: summary.periodEnd,
      thresholdBasisPoints,
      effectiveIncludedMicros: String(summary.effectiveIncludedMicros),
      usedMicros: String(summary.usedMicros),
      heldMicros: String(summary.heldMicros),
      nextResetAt: summary.nextResetAt,
    }));
}

function decodeWarning(row: Row): OrgUsageWarning {
  let warning: OrgUsageWarning;
  try {
    warning = JSON.parse(String(row.payload_json)) as OrgUsageWarning;
  } catch {
    return fail("billing_policy_unavailable", 503);
  }
  if (
    !warning ||
    typeof warning !== "object" ||
    warning.organizationId !== row.org_id ||
    warning.periodStart !== row.period_start ||
    warning.periodEnd !== row.period_end ||
    warning.thresholdBasisPoints !== row.threshold_basis_points
  )
    fail("billing_policy_unavailable", 503);
  reference(warning.organizationId);
  instant(warning.periodStart);
  instant(warning.periodEnd);
  instant(warning.nextResetAt);
  if (
    warning.periodStart >= warning.periodEnd ||
    (warning.periodKind !== "free" && warning.periodKind !== "paid") ||
    (warning.thresholdBasisPoints !== 8000 && warning.thresholdBasisPoints !== 9500)
  )
    fail("billing_policy_unavailable", 503);
  try {
    parseUnsignedMicros(warning.effectiveIncludedMicros);
    parseUnsignedMicros(warning.usedMicros);
    parseUnsignedMicros(warning.heldMicros);
  } catch (error) {
    if (error instanceof MoneyError) fail("billing_policy_unavailable", 503);
    throw error;
  }
  return warning;
}

function warningKey(warning: OrgUsageWarning): string {
  return canonicalJson([
    "org-usage-warning-v1",
    warning.organizationId,
    warning.periodStart,
    warning.periodEnd,
    warning.thresholdBasisPoints,
  ]);
}

export interface OrgCashExposureInput {
  readonly organizationId: string;
  readonly reference: string;
  readonly policyVersion: number;
  readonly consentRevision: string;
  readonly amountMinor: number;
}

export interface OrgCashExposureReceipt extends OrgCashExposureInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: "reserved" | "paid" | "released";
  readonly sourceReference: string | null;
}

/**
 * Internal cash bookkeeping for a future qualified off-session funding owner.
 * This does not activate a mode, authorize a card, fund a lot, or claim capability.
 * The public policy writer cannot produce the on-demand consent this requires.
 */
export function createOrgCashExposureReservations(input: {
  readonly sql: Sql;
  readonly clock?: Clock;
}) {
  const { sql, clock = () => new Date() } = input;
  const find = async (org: string, ref: string) => {
    const row = (
      await sql.query("SELECT * FROM org_wallet_cash_exposures WHERE org_id = ? AND ref = ?", [
        org,
        ref,
      ])
    )[0];
    return row ? exposureReceipt(row) : null;
  };
  const match = (stored: OrgCashExposureReceipt, request: OrgCashExposureInput) => {
    if (
      stored.policyVersion !== request.policyVersion ||
      stored.consentRevision !== request.consentRevision ||
      stored.amountMinor !== request.amountMinor
    )
      fail("reference_conflict", 409);
    return stored;
  };
  return {
    async reserve(request: OrgCashExposureInput): Promise<OrgCashExposureReceipt> {
      reference(request.organizationId);
      reference(request.reference);
      principal(request.consentRevision);
      safeAmount(request.policyVersion);
      if (request.policyVersion < 1) fail("invalid_limit_policy", 400);
      cashAmount(request.amountMinor);
      const stored = await find(request.organizationId, request.reference);
      if (stored) return match(stored, request);
      const row = (
        await sql.query("SELECT * FROM org_wallet_limit_policies WHERE org_id = ?", [
          request.organizationId,
        ])
      )[0];
      if (
        row?.on_limit !== "on-demand" ||
        row.policy_version !== request.policyVersion ||
        row.consent_revision !== request.consentRevision
      )
        fail("off_session_consent_required", 409);
      cashAmount(row.cash_cap_minor);
      const at = clock().toISOString();
      const period = orgCashCapPeriod(at);
      const id = `guard_${crypto.randomUUID()}`;
      const org = request.organizationId;
      try {
        await sql.batch([
          guard(
            id,
            `EXISTS (SELECT 1 FROM org_wallet_limit_policies WHERE org_id = ?
            AND on_limit = 'on-demand' AND policy_version = ? AND consent_revision = ? AND cash_cap_minor = ?)
            AND NOT EXISTS (SELECT 1 FROM org_wallet_cash_exposures WHERE org_id = ? AND status = 'reserved')
            AND COALESCE((SELECT SUM(amount_minor) FROM org_wallet_cash_exposures
              WHERE org_id = ? AND period_start = ? AND status IN ('reserved', 'paid')), 0) <= ?`,
            [
              org,
              request.policyVersion,
              request.consentRevision,
              row.cash_cap_minor,
              org,
              org,
              period.periodStart,
              row.cash_cap_minor - request.amountMinor,
            ],
          ),
          {
            sql: "INSERT INTO org_wallet_cash_cap_buckets (org_id, period_start, period_end) VALUES (?, ?, ?) ON CONFLICT (org_id, period_start) DO NOTHING",
            params: [org, period.periodStart, period.periodEnd],
          },
          {
            sql: "INSERT INTO org_wallet_cash_exposures (org_id, ref, period_start, period_end, policy_version, consent_revision, amount_minor, status, source_ref, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, NULL)",
            params: [
              org,
              request.reference,
              period.periodStart,
              period.periodEnd,
              request.policyVersion,
              request.consentRevision,
              request.amountMinor,
              at,
            ],
          },
          cleanup(id),
        ]);
      } catch (error) {
        if (!(error instanceof SqlError)) throw error;
        const committed = await find(org, request.reference);
        if (committed) return match(committed, request);
        if (error.code === "constraint") fail("cash_cap_or_exposure_conflict", 409);
        fail("billing_policy_unavailable", 503);
      }
      const committed = await find(org, request.reference);
      if (!committed) fail("billing_policy_unavailable", 503);
      return match(committed, request);
    },
    /** Only the funding owner's verified original-source readback supplies this outcome. */
    async resolve(request: {
      readonly organizationId: string;
      readonly reference: string;
      readonly status: "paid" | "released";
      readonly sourceReference: string;
    }): Promise<OrgCashExposureReceipt> {
      reference(request.organizationId);
      reference(request.reference);
      reference(request.sourceReference);
      if (request.status !== "paid" && request.status !== "released")
        fail("invalid_limit_policy", 400);
      const stored = await find(request.organizationId, request.reference);
      if (!stored) fail("cash_exposure_not_found", 404);
      if (stored.status !== "reserved") {
        if (stored.status !== request.status || stored.sourceReference !== request.sourceReference)
          fail("reference_conflict", 409);
        return stored;
      }
      try {
        await sql.run(
          "UPDATE org_wallet_cash_exposures SET status = ?, source_ref = ?, closed_at = ? WHERE org_id = ? AND ref = ? AND status = 'reserved'",
          [
            request.status,
            request.sourceReference,
            clock().toISOString(),
            request.organizationId,
            request.reference,
          ],
        );
      } catch (error) {
        if (!(error instanceof SqlError)) throw error;
        // Never undo a reservation because a processor or database acknowledgement was lost.
      }
      const final = await find(request.organizationId, request.reference);
      if (!final || final.status === "reserved") fail("billing_policy_unavailable", 503);
      if (final.status !== request.status || final.sourceReference !== request.sourceReference)
        fail("reference_conflict", 409);
      return final;
    },
  };
}

function exposureReceipt(row: Row): OrgCashExposureReceipt {
  safeAmount(row.amount_minor);
  safeAmount(row.policy_version);
  instant(row.period_start);
  instant(row.period_end);
  if (!["reserved", "paid", "released"].includes(String(row.status)))
    fail("billing_policy_unavailable", 503);
  return {
    organizationId: String(row.org_id),
    reference: String(row.ref),
    policyVersion: row.policy_version,
    consentRevision: String(row.consent_revision),
    amountMinor: row.amount_minor,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status as OrgCashExposureReceipt["status"],
    sourceReference: row.source_ref === null ? null : String(row.source_ref),
  };
}
