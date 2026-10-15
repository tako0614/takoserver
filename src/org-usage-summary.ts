import {
  hostedCreditLotProvenanceSql,
  type LedgerRefundSource,
  stripeRefundSource,
} from "./ledger.ts";
import type { Row, Sql, SqlStatement } from "./ports.ts";

export interface OrgUsageSummary {
  readonly organizationId: string;
  readonly currency: "USD";
  readonly unit: "USD-micros";
  readonly periodKind: "free" | "paid";
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly nextResetAt: string;
  readonly originalIncludedMicros: number;
  readonly effectiveIncludedMicros: number;
  readonly usedMicros: number;
  readonly heldMicros: number;
  readonly availableMicros: number;
  readonly revokedMicros: number;
  readonly utilizationBasisPoints: number;
  readonly reached80Percent: boolean;
  readonly reached95Percent: boolean;
  readonly limitReached: boolean;
  readonly purchasedAvailableMicros: number;
  readonly directAvailableMicros: number;
}

export class OrgUsageSummaryUnavailable extends Error {
  constructor() {
    super("billing_unavailable");
    this.name = "OrgUsageSummaryUnavailable";
  }
}

const unavailable = (): never => {
  throw new OrgUsageSummaryUnavailable();
};

function micros(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return unavailable();
  return value;
}

function canonicalTime(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return unavailable();
  if (new Date(value).toISOString() !== value) return unavailable();
  return value;
}

/**
 * One SQLite/D1 read snapshot chooses the current entitlement and its own lot.
 * The runtime selects a qualified refund projection before building this read;
 * legacy self-hosted wallets omit refund tables when they are absent.
 */
export interface OrgUsageSummaryReadInput {
  readonly organizationId: string;
  readonly instant: string;
  readonly hostedPaidFreeExclusion: boolean;
  readonly hostedCreditProvenance?: boolean;
  /** Qualified read source selected by the async runtime; omission preserves legacy pure callers. */
  readonly refundSource?: LedgerRefundSource | null;
}

export async function readOrgUsageSummary(
  input: OrgUsageSummaryReadInput & { readonly sql: Sql },
): Promise<OrgUsageSummary> {
  const refundSource =
    input.refundSource === undefined ? await stripeRefundSource(input.sql) : input.refundSource;
  const statement = orgUsageSummaryReadStatement({ ...input, refundSource });
  return parseOrgUsageSummaryRows(await input.sql.query(statement.sql, statement.params), input);
}

/** Reused inside atomic INSERT SELECT so entitlement and Workspace totals share one snapshot. */
export function orgUsageSummaryReadStatement(input: OrgUsageSummaryReadInput): SqlStatement {
  const { organizationId: org, instant, hostedPaidFreeExclusion: hosted } = input;
  canonicalTime(instant);
  const refundSource =
    input.refundSource === undefined
      ? hosted
        ? "stripe_billing_refunds"
        : null
      : input.refundSource;
  if (hosted && refundSource === null) return unavailable();
  const month = instant.slice(0, 7);
  const freeRef = `free:${org}:${month}`;
  const provenance =
    input.hostedCreditProvenance === true ? hostedCreditLotProvenanceSql(hosted) : "1";
  const paid = hosted
    ? `SELECT g.funding_ref, g.kind, g.consumption_class, g.amount_micros,
              g.period_start, g.period_end,
              COALESCE((SELECT MAX(r.target_revoked_micros)
                FROM ${refundSource} r
                WHERE r.org_id = g.org_id AND r.funding_ref = g.funding_ref), 0) AS revoked_micros
       FROM stripe_billing_grants g
       WHERE g.org_id = ? AND g.source_type = 'invoice'
         AND g.period_start <= ? AND g.period_end > ?
         AND NOT EXISTS (SELECT 1 FROM ${refundSource} r
           WHERE r.org_id = g.org_id AND r.funding_ref = g.funding_ref
             AND r.cumulative_refunded_micros >= g.consideration_micros)`
    : `SELECT NULL AS funding_ref, NULL AS kind, NULL AS consumption_class,
              NULL AS amount_micros, NULL AS period_start, NULL AS period_end,
              NULL AS revoked_micros WHERE 0`;
  const pendingFence = hosted
    ? `EXISTS (SELECT 1 FROM stripe_billing_fences f
         WHERE f.org_id = s.org_id AND f.active = 1
           AND (f.funding_ref LIKE 'stripe:invoice:%'
             OR EXISTS (SELECT 1 FROM stripe_billing_grants g
               WHERE g.org_id = f.org_id AND g.funding_ref = f.funding_ref
                 AND g.source_type = 'invoice')))`
    : "0";
  const refundDebit =
    refundSource !== null
      ? `COALESCE((SELECT SUM(r.debit_micros + r.expired_micros)
       FROM ${refundSource} r WHERE r.org_id = l.org_id AND r.funding_ref = l.ref), 0)`
      : "0";
  const additionalFence =
    refundSource !== null
      ? `AND NOT EXISTS (SELECT 1 FROM stripe_billing_fences f
       WHERE f.org_id = l.org_id AND f.funding_ref = l.ref AND f.active = 1)`
      : "";
  const paidFreeExclusion = hosted
    ? "AND (l.consumption_class <> 'free' OR NOT EXISTS (SELECT 1 FROM paid))"
    : "";
  return {
    sql: `WITH paid AS (${paid}),
      additional AS (
        SELECT l.kind, l.consumption_class, (${provenance}) AS provenance_verified,
          l.amount_micros
          - COALESCE((SELECT SUM(a.amount_micros) FROM wallet_credit_allocations a
              WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
                AND a.debit_type IN ('capture', 'usage_debit', 'hold')), 0)
          - ${refundDebit} AS available_micros
        FROM wallet_credit_lots l
        WHERE l.org_id = ? AND l.kind IN ('purchased', 'direct')
          AND (l.expires_at IS NULL OR l.expires_at > ?)
          ${additionalFence} ${paidFreeExclusion}
      )
    SELECT s.org_id, s.ref AS snapshot_ref, s.amount_micros AS snapshot_amount,
      s.expires_at AS snapshot_end, s.money_policy AS snapshot_policy,
      t.amount_micros AS tariff_amount, t.expires_at AS tariff_end,
      t.pricing_revision AS tariff_revision, s.pricing_revision AS snapshot_revision,
      p.funding_ref AS paid_ref, p.kind AS paid_kind, p.consumption_class AS paid_class,
      p.amount_micros AS paid_amount, p.period_start AS paid_start,
      p.period_end AS paid_end, p.revoked_micros AS paid_revoked,
      (SELECT COUNT(*) FROM paid) AS paid_count,
      ${pendingFence} AS pending_fence,
      l.kind AS lot_kind, l.consumption_class AS lot_class,
      l.amount_micros AS lot_amount, l.expires_at AS lot_end,
      COALESCE((SELECT SUM(a.amount_micros) FROM wallet_credit_allocations a
        WHERE a.org_id = s.org_id AND a.lot_ref = COALESCE(p.funding_ref, s.ref)
          AND a.debit_type IN ('capture', 'usage_debit')), 0) AS used_micros,
      COALESCE((SELECT SUM(a.amount_micros) FROM wallet_credit_allocations a
        WHERE a.org_id = s.org_id AND a.lot_ref = COALESCE(p.funding_ref, s.ref)
          AND a.debit_type = 'hold'), 0) AS held_micros,
      COALESCE((SELECT SUM(available_micros) FROM additional
        WHERE consumption_class = 'purchased' AND provenance_verified = 1), 0) AS purchased_available,
      COALESCE((SELECT SUM(available_micros) FROM additional
        WHERE kind = 'direct' AND (consumption_class <> 'purchased' OR provenance_verified = 0)), 0) AS direct_available,
      (SELECT MIN(available_micros) FROM additional) AS additional_min
    FROM org_wallet_grant_snapshots s
    LEFT JOIN org_wallet_monthly_tariffs t ON t.month = ?
    LEFT JOIN paid p ON 1 = 1
    LEFT JOIN wallet_credit_lots l ON l.org_id = s.org_id
      AND l.ref = COALESCE(p.funding_ref, s.ref)
    WHERE s.org_id = ? AND s.ref = ?`,
    params: [...(hosted ? [org, instant, instant] : []), org, instant, month, org, freeRef],
  };
}

export function parseOrgUsageSummaryRows(
  rows: readonly Row[],
  input: OrgUsageSummaryReadInput,
): OrgUsageSummary {
  const { organizationId: org, instant } = input;
  canonicalTime(instant);
  const month = instant.slice(0, 7);
  const monthStart = `${month}-01T00:00:00.000Z`;
  const monthEndDate = new Date(monthStart);
  monthEndDate.setUTCMonth(monthEndDate.getUTCMonth() + 1);
  const monthEnd = monthEndDate.toISOString();
  const freeRef = `free:${org}:${month}`;
  if (rows.length !== 1) return unavailable();
  const row = rows[0];
  if (
    !row ||
    row.org_id !== org ||
    micros(row, "paid_count") > 1 ||
    micros(row, "pending_fence") !== 0
  )
    return unavailable();
  const paidCurrent = micros(row, "paid_count") === 1;
  if (
    row.snapshot_ref !== freeRef ||
    row.snapshot_policy !== "usd-micros-v2" ||
    micros(row, "snapshot_amount") !== micros(row, "tariff_amount") ||
    row.snapshot_revision !== row.tariff_revision ||
    canonicalTime(row.snapshot_end) !== monthEnd ||
    canonicalTime(row.tariff_end) !== monthEnd
  )
    return unavailable();
  if (row.additional_min !== null && micros(row, "additional_min") < 0) return unavailable();
  const periodStart = paidCurrent ? canonicalTime(row.paid_start) : monthStart;
  const periodEnd = paidCurrent ? canonicalTime(row.paid_end) : monthEnd;
  if (periodStart > instant || periodEnd <= instant || periodStart >= periodEnd)
    return unavailable();
  const original = paidCurrent ? micros(row, "paid_amount") : micros(row, "snapshot_amount");
  const revoked = paidCurrent ? micros(row, "paid_revoked") : 0;
  const used = micros(row, "used_micros");
  const held = micros(row, "held_micros");
  if (revoked > original || BigInt(used) + BigInt(held) > BigInt(original)) return unavailable();
  if (
    paidCurrent &&
    (row.paid_kind !== "plan-included" ||
      row.paid_class !== "subscription" ||
      typeof row.paid_ref !== "string")
  )
    return unavailable();
  if (original === 0) {
    if (row.lot_amount !== null) return unavailable();
  } else if (
    row.lot_kind !== "plan-included" ||
    row.lot_class !== (paidCurrent ? "subscription" : "free") ||
    micros(row, "lot_amount") !== original ||
    row.lot_end !== periodEnd
  )
    return unavailable();
  const net = BigInt(original) - BigInt(revoked);
  const consumed = BigInt(used) + BigInt(held);
  const available = net > consumed ? Number(net - consumed) : 0;
  const rawBasisPoints = net === 0n ? 0n : (consumed * 10_000n) / net;
  const utilizationBasisPoints = Number(rawBasisPoints > 10_000n ? 10_000n : rawBasisPoints);
  return {
    organizationId: org,
    currency: "USD",
    unit: "USD-micros",
    periodKind: paidCurrent ? "paid" : "free",
    periodStart,
    periodEnd,
    nextResetAt: periodEnd,
    originalIncludedMicros: original,
    effectiveIncludedMicros: Number(net),
    usedMicros: used,
    heldMicros: held,
    availableMicros: available,
    revokedMicros: revoked,
    utilizationBasisPoints,
    reached80Percent: utilizationBasisPoints >= 8_000,
    reached95Percent: utilizationBasisPoints >= 9_500,
    limitReached: net === 0n || consumed >= net,
    purchasedAvailableMicros: micros(row, "purchased_available"),
    directAvailableMicros: micros(row, "direct_available"),
  };
}
