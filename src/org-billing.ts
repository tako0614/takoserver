import {
  type BillingConfig,
  BillingConfigError,
  computeMeterAmountMicros,
  parseBillingConfig,
} from "./billing-config.ts";
import { base64UrlDecode, base64UrlEncode, canonicalJson } from "./json.ts";
import {
  hostedPaidFreeBlockedParams,
  hostedPaidFreeBlockedSql,
  invoiceCreditPeriodEligibleParams,
  invoiceCreditPeriodEligibleSql,
  type Ledger,
  LedgerError,
  prepareLedgerAllocation,
  stripeInvoiceGrantSchemaReady,
  stripeRefundSchemaReady,
  type Wallet,
} from "./ledger.ts";
import { MoneyError, minorToMicros } from "./money.ts";
import {
  type OrgLimitAdmission,
  type OrgLimitPolicy,
  OrgLimitPolicyError,
} from "./org-limit-policy.ts";
import {
  type OrgUsageSummary,
  OrgUsageSummaryUnavailable,
  orgUsageSummaryReadStatement,
  readOrgUsageSummary,
} from "./org-usage-summary.ts";
import {
  assertWorkspaceOwner,
  measuredAttributionInterval,
  measuredAttributionStatement,
  OrgWorkspaceUsageError,
  type OrgWorkspaceUsagePage,
  readOrgWorkspaceUsage,
  validateWorkspaceRef,
  type WorkspaceUsageOptions,
  workspaceAttributionSchemaReady,
  workspaceBindingStatement,
} from "./org-workspace-usage.ts";
import { type Clock, type Row, type Sql, SqlError, type SqlStatement } from "./ports.ts";

export class OrgBillingError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "OrgBillingError";
  }
}

export interface HoldReceipt {
  readonly organizationId: string;
  readonly reference: string;
  readonly workspaceRef: string | null;
  readonly attributionPeriodStart: string | null;
  readonly attributionPeriodEnd: string | null;
  readonly moneyPolicy: MoneyPolicy;
  readonly amountMicros: number;
  readonly pricingRevision: string | null;
  readonly status: "live" | "captured" | "released" | "expired";
  readonly capturedMicros: number;
  readonly releasedMicros: number;
  readonly actualMicros: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly closedAt: string | null;
  readonly closureReason?: string | null;
}

export interface UsageReceipt {
  readonly organizationId: string;
  readonly reference: string;
  readonly workspaceRef: string | null;
  readonly attributionPeriodStart: string | null;
  readonly attributionPeriodEnd: string | null;
  readonly moneyPolicy: MoneyPolicy;
  readonly pricingRevision: string;
  readonly meter: string;
  readonly quantity: string;
  readonly quantityUnit: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly rate: { readonly numeratorMicros: string; readonly denominator: string };
  readonly amountMicros: number;
  readonly status: "pending" | "paid";
  readonly createdAt: string;
  readonly paidAt: string | null;
}

export interface CreditLot {
  readonly reference: string;
  readonly kind: "direct" | "plan-included" | "purchased";
  readonly consumptionClass: "free" | "subscription" | "purchased";
  readonly amountMicros: number;
  readonly spentMicros: number;
  readonly remainingMicros: number;
  readonly heldMicros: number;
  readonly availableMicros: number;
  readonly revokedMicros?: number;
  readonly frozen?: boolean;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export type MoneyPolicy = "usd-cents-v1" | "usd-micros-v2";

export interface HoldInput {
  readonly workspaceRef?: string;
  readonly organizationId: string;
  readonly reference: string;
  readonly amountMicros: number;
  readonly pricingRevision: string;
  readonly measurementFingerprint: string;
}

export interface CaptureInput {
  readonly organizationId: string;
  readonly reference: string;
  readonly amountMicros: number;
  readonly actualMicros: string;
  readonly measurementFingerprint: string;
}

export interface UsageInput {
  readonly workspaceRef?: string;
  readonly organizationId: string;
  readonly reference: string;
  readonly meter: string;
  readonly quantity: string;
  readonly quantityUnit: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly pricingRevision: string;
  readonly expectedMicros: number;
  readonly measurementFingerprint: string;
}

export interface UsagePage {
  readonly usageRecords: readonly UsageReceipt[];
  readonly cursor: string | null;
}

export interface LotPage {
  readonly lots: readonly CreditLot[];
  readonly cursor: string | null;
}

export interface OrgBilling {
  wallet(organizationId: string): Promise<Wallet>;
  usageSummary(organizationId: string): Promise<OrgUsageSummary>;
  workspaceUsage(
    organizationId: string,
    options?: WorkspaceUsageOptions,
  ): Promise<OrgWorkspaceUsagePage>;
  lots(organizationId: string, limit?: number, cursor?: string): Promise<LotPage>;
  hold(input: HoldInput): Promise<HoldReceipt>;
  readHold(organizationId: string, reference: string): Promise<HoldReceipt>;
  capture(input: CaptureInput): Promise<HoldReceipt>;
  release(organizationId: string, reference: string): Promise<HoldReceipt>;
  usage(input: UsageInput): Promise<UsageReceipt>;
  listUsage(organizationId: string, limit?: number, cursor?: string): Promise<UsagePage>;
  expireDue(limit: number, organizationId?: string): Promise<number>;
}

/** An enabled entry refuses to serve before the additive migration is applied. */
export async function assertOrgBillingSchema(
  sql: Sql,
  config?: BillingConfig,
  clock: Clock = () => new Date(),
): Promise<void> {
  const rows = await sql.query(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('org_wallet_holds', 'org_wallet_usage_records', 'org_wallet_grant_snapshots', 'org_wallet_pricing_revisions', 'org_wallet_monthly_tariffs', 'money_unit_policy')",
  );
  if (rows.length !== 6) throw new OrgBillingError("billing_schema_not_ready", 503);
  const requiredColumns: Record<string, readonly string[]> = {
    ledger: ["settled_delta_micros", "held_delta_micros"],
    wallet_credit_lots: ["amount_micros", "consumption_class", "cursor_handle"],
    wallet_credit_allocations: ["amount_micros"],
    org_wallet_holds: ["amount_micros", "captured_micros", "released_micros", "money_policy"],
    org_wallet_usage_records: ["amount_micros", "money_policy"],
    org_wallet_grant_snapshots: ["amount_micros", "money_policy"],
    org_wallet_monthly_tariffs: ["amount_micros", "money_policy"],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const present = new Set(
      (await sql.query(`PRAGMA table_info(${table})`)).map((row) => row.name),
    );
    if (columns.some((column) => !present.has(column)))
      throw new OrgBillingError("billing_schema_not_ready", 503);
  }
  const unitPolicy = await sql.query(
    "SELECT ledger_unit, historical_usage_unit, cash_unit FROM money_unit_policy WHERE singleton = 1",
  );
  if (
    unitPolicy.length !== 1 ||
    unitPolicy[0]?.ledger_unit !== "usd-micros-v2" ||
    unitPolicy[0]?.historical_usage_unit !== "microcent-v1" ||
    unitPolicy[0]?.cash_unit !== "usd-cents-v1"
  )
    throw new OrgBillingError("billing_schema_not_ready", 503);
  const cursorObjects = await sql.query(
    "SELECT name FROM sqlite_schema WHERE (type = 'index' AND name = 'wallet_credit_lots_cursor') OR (type = 'trigger' AND name IN ('wallet_credit_lots_cursor_insert', 'wallet_credit_lots_cursor_immutable'))",
  );
  if (cursorObjects.length !== 3) throw new OrgBillingError("billing_schema_not_ready", 503);
  if (config) {
    for (const tariff of [...(config.history ?? []), config])
      checkedGrantMicros(tariff.freeIncludedMinor);
    await registerTariffs(sql, config, clock().toISOString());
  }
}

async function registerTariffs(sql: Sql, config: BillingConfig, instant: string): Promise<void> {
  const { history = [], ...current } = config;
  const existing = await sql.query(
    "SELECT revision, effective_at, config_json FROM org_wallet_pricing_revisions",
  );
  const proposed = [...history, current];
  const additions = proposed.filter(
    (tariff) => !existing.some((row) => row.revision === tariff.revision),
  );
  for (const tariff of proposed) {
    const prior = existing.find((row) => row.revision === tariff.revision);
    if (
      prior &&
      (prior.effective_at !== tariff.effectiveAt || prior.config_json !== canonicalJson(tariff))
    )
      orgBillingFail("pricing_revision_conflict", 503);
    if (!prior && existing.length > 0 && tariff.effectiveAt < instant)
      orgBillingFail("pricing_revision_backdated", 503);
  }
  if (!additions.length) return;
  const guardId = `guard_${crypto.randomUUID()}`;
  try {
    await sql.batch([
      guard(guardId, "(SELECT COUNT(*) FROM org_wallet_pricing_revisions) = ?", [existing.length]),
      ...additions.map((tariff) => ({
        sql: "INSERT INTO org_wallet_pricing_revisions (revision, effective_at, config_json) VALUES (?, ?, ?)",
        params: [tariff.revision, tariff.effectiveAt, canonicalJson(tariff)],
      })),
      { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [guardId] },
    ]);
  } catch (error) {
    if (!(error instanceof SqlError)) throw error;
    // Exact concurrent registration or a lost ACK is harmless. A competing
    // bootstrap must not smuggle a retroactive revision in after the first.
    const committed = await sql.query(
      "SELECT revision, effective_at, config_json FROM org_wallet_pricing_revisions",
    );
    if (
      proposed.every((tariff) =>
        committed.some(
          (row) =>
            row.revision === tariff.revision &&
            row.effective_at === tariff.effectiveAt &&
            row.config_json === canonicalJson(tariff),
        ),
      )
    )
      return;
    orgBillingFail("pricing_revision_conflict", 503);
  }
}

/**
 * Organization wallet lifecycle. Reads are advisory; every money write shares
 * one SQL batch with a durable lifecycle fence. D1 and SQLite both roll back
 * the entire batch when a CHECK/unique guard fails. No network side effect is
 * hidden inside this transaction.
 */
export function createOrgBilling(options: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly ledger: Ledger;
  readonly config: BillingConfig;
  readonly hostedPaidFreeExclusion?: boolean;
  /** Hosted composition requires explicit attribution for new admissions; old receipts still replay. */
  readonly requireWorkspaceAttribution?: boolean;
  readonly limitPolicy?: Pick<
    OrgLimitPolicy,
    "prepareAdmission" | "observeUsageSummary" | "warningStatements"
  >;
}): OrgBilling {
  const { sql, clock, ledger, config } = options;
  const hostedPaidFreeExclusion = options.hostedPaidFreeExclusion === true;
  const refundsReady = () => stripeRefundSchemaReady(sql);
  const now = () => clock().toISOString();
  const held = async (org: string, ref: string) =>
    (await sql.query("SELECT * FROM org_wallet_holds WHERE org_id = ? AND ref = ?", [org, ref]))[0];
  const usageRow = async (org: string, ref: string) =>
    (
      await sql.query("SELECT * FROM org_wallet_usage_records WHERE org_id = ? AND ref = ?", [
        org,
        ref,
      ])
    )[0];

  async function tariffAt(instant: string): Promise<BillingConfig | undefined> {
    const row = (
      await sql.query(
        "SELECT config_json FROM org_wallet_pricing_revisions WHERE effective_at <= ? ORDER BY effective_at DESC LIMIT 1",
        [instant],
      )
    )[0];
    return row ? parseBillingConfig(String(row.config_json)) : undefined;
  }

  async function sweep(limit: number, cutoff: string, org?: string): Promise<number> {
    const rows = await sql.query(
      `SELECT * FROM org_wallet_holds WHERE state = 'live' AND expires_at <= ? ${org === undefined ? "" : "AND org_id = ?"} ORDER BY expires_at, org_id, ref LIMIT ?`,
      org === undefined ? [cutoff, limit] : [cutoff, org, limit],
    );
    for (const row of rows) await close(row, "expired", 0);
    return rows.length;
  }

  async function prepare(org: string): Promise<void> {
    await registerTariffs(sql, config, now());
    // The bounded sweep and its backlog check read one instant. A deadline that
    // passes after it is not backlog: every terminal write fences on its own
    // deadline, and `current` closes such a row as expired before reporting it.
    const cutoff = now();
    await sweep(8, cutoff, org);
    if (
      (
        await sql.query(
          "SELECT 1 FROM org_wallet_holds WHERE org_id = ? AND state = 'live' AND expires_at <= ? LIMIT 1",
          [org, cutoff],
        )
      ).length
    )
      orgBillingFail("billing_maintenance_pending", 503);
    const instant = now();
    const month = instant.slice(0, 7);
    const monthStart = `${month}-01T00:00:00.000Z`;
    const nextMonth = new Date(monthStart);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const monthly = await tariffAt(monthStart);
    // The first access freezes one policy for the whole month, including zero
    // eligibility. An initial mid-month tariff starts free grants next month.
    await sql.run(
      `INSERT OR IGNORE INTO org_wallet_monthly_tariffs (month, pricing_revision, amount_micros, expires_at, created_at, money_policy) VALUES (?, ?, ?, ?, ?, 'usd-micros-v2')`,
      [
        month,
        monthly?.revision ?? "unconfigured",
        monthly ? checkedGrantMicros(monthly.freeIncludedMinor) : 0,
        nextMonth.toISOString(),
        instant,
      ],
    );
    const policy = (
      await sql.query("SELECT * FROM org_wallet_monthly_tariffs WHERE month = ?", [month])
    )[0];
    if (!policy) orgBillingFail("billing_unavailable", 503);
    const ref = `free:${org}:${month}`;
    await sql.run(
      `INSERT OR IGNORE INTO org_wallet_grant_snapshots (org_id, ref, pricing_revision, amount_micros, expires_at, created_at, money_policy) VALUES (?, ?, ?, ?, ?, ?, 'usd-micros-v2')`,
      [
        org,
        ref,
        String(policy.pricing_revision),
        Number(policy.amount_micros),
        String(policy.expires_at),
        instant,
      ],
    );
    const snapshot = (
      await sql.query(
        "SELECT amount_micros, expires_at FROM org_wallet_grant_snapshots WHERE org_id = ? AND ref = ?",
        [org, ref],
      )
    )[0];
    if (!snapshot) orgBillingFail("billing_unavailable", 503);
    if (Number(snapshot.amount_micros) > 0)
      await ledger.fund({
        organizationId: org,
        fundingRef: ref,
        amountMicros: Number(snapshot.amount_micros),
        kind: "plan-included",
        consumptionClass: "free",
        expiresAt: String(snapshot.expires_at),
      });
  }

  function usageWarningStatements(org: string, instant: string): readonly SqlStatement[] {
    return (
      options.limitPolicy?.warningStatements({
        organizationId: org,
        instant,
        summaryRead: orgUsageSummaryReadStatement({
          organizationId: org,
          instant,
          hostedPaidFreeExclusion,
          hostedCreditProvenance: true,
        }),
      }) ?? []
    );
  }

  async function close(
    row: Row,
    state: "captured" | "released" | "expired",
    captured: number,
    captureFingerprint: string | null = null,
    actualMicros: string | null = null,
  ): Promise<HoldReceipt> {
    const refundSchema = await refundsReady();
    const org = String(row.org_id);
    const ref = String(row.ref);
    const ledgerRef = String(row.ledger_ref);
    const amount = Number(row.amount_micros);
    const instant = now();
    const guards: SqlStatement[] = [];
    const guardId = `guard_${crypto.randomUUID()}`;
    guards.push(
      {
        sql: `UPDATE org_wallet_holds SET state = ?, captured_micros = ?, released_micros = ?,
            capture_fingerprint = ?, actual_micros = ?, closed_at = ?
            WHERE org_id = ? AND ref = ? AND state = 'live'
              AND ${state === "expired" ? "expires_at <= ?" : "expires_at > ?"}`,
        params: [
          state,
          captured,
          amount - captured,
          captureFingerprint,
          actualMicros,
          instant,
          org,
          ref,
          instant,
        ],
      },
      guard(guardId, "changes() = 1"),
    );
    if (captured > 0 && refundSchema)
      guards.push(
        guard(
          `${guardId}_freeze`,
          `NOT EXISTS (SELECT 1 FROM wallet_credit_allocations a
        JOIN stripe_billing_fences f ON f.org_id = a.org_id AND f.funding_ref = a.lot_ref
          AND f.active = 1
        WHERE a.org_id = ? AND a.debit_type = 'hold' AND a.debit_ref = ?)`,
          [org, ledgerRef],
        ),
      );
    // Also fence the precise original hold. Other internal ledger callers may
    // not partially settle a public lifecycle behind its durable state row.
    guards.push(
      guard(
        `${guardId}_hold`,
        `
      (SELECT COALESCE(SUM(held_delta_micros), 0) FROM ledger WHERE org_id = ? AND ref = ?) = ?
      AND (SELECT COALESCE(SUM(amount_micros), 0) FROM wallet_credit_allocations
           WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?) = ?
      AND NOT EXISTS (SELECT 1 FROM ledger WHERE org_id = ? AND ref = ? AND type IN ('capture', 'release'))`,
        [org, ledgerRef, amount, org, ledgerRef, amount, org, ledgerRef],
      ),
    );
    const allocations = await sql.query(
      `SELECT a.lot_ref, a.amount_micros FROM wallet_credit_allocations a
       JOIN wallet_credit_lots l ON l.org_id = a.org_id AND l.ref = a.lot_ref
       WHERE a.org_id = ? AND a.debit_type = 'hold' AND a.debit_ref = ?
       ORDER BY CASE l.consumption_class WHEN 'free' THEN 0 WHEN 'subscription' THEN 1 ELSE 2 END,
         CASE WHEN l.expires_at IS NULL THEN 1 ELSE 0 END, l.expires_at, l.created_at, l.ref`,
      [org, ledgerRef],
    );
    let remaining = captured;
    for (const allocation of allocations) {
      const used = Math.min(remaining, Number(allocation.amount_micros));
      if (used > 0)
        guards.push({
          sql: `INSERT INTO wallet_credit_allocations (org_id, debit_type, debit_ref, lot_ref, amount_micros, created_at)
              VALUES (?, 'capture', ?, ?, ?, ?)`,
          params: [org, ledgerRef, String(allocation.lot_ref), used, instant],
        });
      remaining -= used;
    }
    if (remaining !== 0) orgBillingFail("billing_unavailable", 503);
    guards.push({
      sql: "DELETE FROM wallet_credit_allocations WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?",
      params: [org, ledgerRef],
    });
    if (captured > 0) guards.push(entry(org, "capture", ledgerRef, -captured, -captured, instant));
    if (amount > captured)
      guards.push(entry(org, "release", ledgerRef, 0, captured - amount, instant));
    guards.push(...usageWarningStatements(org, instant));
    guards.push({
      sql: `DELETE FROM wallet_allocation_guards WHERE id IN (${captured > 0 && refundSchema ? "?, ?, ?" : "?, ?"})`,
      params:
        captured > 0 && refundSchema
          ? [guardId, `${guardId}_hold`, `${guardId}_freeze`]
          : [guardId, `${guardId}_hold`],
    });
    try {
      await sql.batch(guards);
    } catch (error) {
      if (!(error instanceof SqlError)) throw error;
      const committed = await held(org, ref);
      if (committed && committed.state !== "live") {
        if (captureFingerprint !== null) {
          if (committed.capture_fingerprint == null) orgBillingFail("hold_closed", 409);
          if (committed.capture_fingerprint !== captureFingerprint)
            orgBillingFail("reference_conflict", 409);
        }
        return holdReceipt(committed);
      }
      // A capture straddling its deadline must release, even if a sweeper has
      // not run yet. Never admit a late settlement by retrying the old batch.
      if (committed && state !== "expired" && String(committed.expires_at) <= now()) {
        const expired = await close(committed, "expired", 0);
        if (captureFingerprint !== null) orgBillingFail("hold_closed", 409);
        return expired;
      }
      orgBillingFail("billing_unavailable", 503);
    }
    const receipt = await held(org, ref);
    if (!receipt) orgBillingFail("billing_unavailable", 503);
    return holdReceipt(receipt);
  }

  /** A live row past its deadline closes as expired; it is never reported live. */
  async function current(row: Row): Promise<HoldReceipt> {
    return row.state === "live" && String(row.expires_at) <= now()
      ? close(row, "expired", 0)
      : holdReceipt(row);
  }

  const service: OrgBilling = {
    async wallet(org) {
      await prepare(org);
      return ledger.wallet(org);
    },
    async usageSummary(org) {
      try {
        await prepare(org);
        const summary = await readOrgUsageSummary({
          sql,
          organizationId: org,
          instant: now(),
          hostedPaidFreeExclusion,
          hostedCreditProvenance: options.limitPolicy !== undefined,
        });
        if (options.limitPolicy)
          await workspaceOperation(options.limitPolicy.observeUsageSummary(summary));
        return summary;
      } catch (error) {
        if (
          error instanceof OrgUsageSummaryUnavailable ||
          error instanceof LedgerError ||
          error instanceof MoneyError ||
          error instanceof SqlError
        )
          orgBillingFail("billing_unavailable", 503);
        throw error;
      }
    },
    async workspaceUsage(org, query) {
      // Continuations read durable rows without sweeping or opening a new period.
      if (query?.cursor === undefined) await prepare(org);
      return workspaceOperation(
        readOrgWorkspaceUsage({
          sql,
          organizationId: org,
          instant: now(),
          hostedPaidFreeExclusion,
          hostedCreditProvenance: options.limitPolicy !== undefined,
          ...(query === undefined ? {} : { options: query }),
        }),
      );
    },
    async lots(org, limit = 100, cursor) {
      const refundSchema = await refundsReady();
      const invoiceGrantsReady = await stripeInvoiceGrantSchemaReady(sql);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        orgBillingFail("invalid_limit", 400);
      let after: Row | undefined;
      if (cursor !== undefined) {
        if (!/^[a-f0-9]{32}$/u.test(cursor)) orgBillingFail("invalid_cursor", 400);
        // A random stable handle supports arbitrarily long pre-existing refs.
        // Resolve only in this Organization; the cursor never grants access.
        after = (
          await sql.query(
            "SELECT ref, consumption_class, expires_at, created_at FROM wallet_credit_lots WHERE org_id = ? AND cursor_handle = ?",
            [org, cursor],
          )
        )[0];
        if (!after) orgBillingFail("invalid_cursor", 400);
      }
      await prepare(org);
      const instant = now();
      const paidRows = hostedPaidFreeExclusion
        ? await sql.query(
            `SELECT ${hostedPaidFreeBlockedSql} AS blocked`,
            hostedPaidFreeBlockedParams(org, instant),
          )
        : [];
      if (
        hostedPaidFreeExclusion &&
        (paidRows.length !== 1 || ![0, 1].includes(Number(paidRows[0]?.blocked)))
      )
        orgBillingFail("billing_unavailable", 503);
      const paidFreeBlocked = Number(paidRows[0]?.blocked) === 1;
      const classRank = after ? lotClassRank(String(after.consumption_class)) : 0;
      const nullableRank = after?.expires_at == null ? 1 : 0;
      const boundary = after
        ? `AND (
          CASE consumption_class WHEN 'free' THEN 0 WHEN 'subscription' THEN 1 ELSE 2 END,
          CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END,
          COALESCE(expires_at, ''), created_at, ref
        ) > (?, ?, ?, ?, ?)`
        : "";
      const rows = await sql.query(
        `SELECT l.*,
          COALESCE(SUM(CASE WHEN a.debit_type = 'hold' THEN a.amount_micros ELSE 0 END), 0) AS held_micros,
          COALESCE(SUM(CASE WHEN a.debit_type IN ('capture', 'usage_debit') THEN a.amount_micros ELSE 0 END), 0) AS spent_micros,
          ${
            refundSchema
              ? `COALESCE((SELECT SUM(r.debit_micros + r.expired_micros)
             FROM stripe_billing_refunds r WHERE r.org_id = l.org_id AND r.funding_ref = l.ref), 0)`
              : "0"
          } AS revoked_micros,
          ${
            refundSchema
              ? `EXISTS (SELECT 1 FROM stripe_billing_fences f
             WHERE f.org_id = l.org_id AND f.funding_ref = l.ref AND f.active = 1)`
              : "0"
          } AS frozen,
          ${invoiceGrantsReady ? invoiceCreditPeriodEligibleSql : "1"} AS invoice_period_eligible
         FROM (SELECT * FROM wallet_credit_lots WHERE org_id = ? ${boundary}
           ORDER BY CASE consumption_class WHEN 'free' THEN 0 WHEN 'subscription' THEN 1 ELSE 2 END,
             CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at, created_at, ref LIMIT ?) l
         LEFT JOIN wallet_credit_allocations a ON a.org_id = l.org_id AND a.lot_ref = l.ref
         GROUP BY l.org_id, l.ref
         ORDER BY CASE l.consumption_class WHEN 'free' THEN 0 WHEN 'subscription' THEN 1 ELSE 2 END,
           CASE WHEN l.expires_at IS NULL THEN 1 ELSE 0 END, l.expires_at, l.created_at, l.ref`,
        after
          ? [
              ...(invoiceGrantsReady ? invoiceCreditPeriodEligibleParams(instant) : []),
              org,
              classRank,
              nullableRank,
              String(after.expires_at ?? ""),
              String(after.created_at),
              String(after.ref),
              limit + 1,
            ]
          : [
              ...(invoiceGrantsReady ? invoiceCreditPeriodEligibleParams(instant) : []),
              org,
              limit + 1,
            ],
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const lots = page.map((row) => {
        const amountMicros = Number(row.amount_micros);
        const spentMicros = Number(row.spent_micros);
        const heldMicros = Number(row.held_micros);
        const revokedMicros = Number(row.revoked_micros);
        const remainingMicros = amountMicros - spentMicros - revokedMicros;
        return {
          reference: String(row.ref),
          kind: row.kind as CreditLot["kind"],
          consumptionClass: row.consumption_class as CreditLot["consumptionClass"],
          amountMicros,
          spentMicros,
          remainingMicros,
          heldMicros,
          revokedMicros,
          frozen: Number(row.frozen) === 1,
          availableMicros:
            !Number(row.frozen) &&
            Number(row.invoice_period_eligible) === 1 &&
            !(hostedPaidFreeExclusion && row.consumption_class === "free" && paidFreeBlocked) &&
            (row.expires_at == null || String(row.expires_at) > instant)
              ? remainingMicros - heldMicros
              : 0,
          expiresAt: nullable(row.expires_at),
          createdAt: String(row.created_at),
        };
      });
      return {
        lots,
        cursor: rows.length > limit && last ? String(last.cursor_handle) : null,
      };
    },
    async hold(input) {
      const refundSchema = await refundsReady();
      reference(input.reference);
      spendableMicros(input.amountMicros);
      fingerprint(input.measurementFingerprint);
      if (input.workspaceRef !== undefined) workspaceReference(input.workspaceRef);
      const signature = JSON.stringify([
        input.amountMicros,
        input.pricingRevision,
        input.measurementFingerprint,
        ...(input.workspaceRef === undefined ? [] : [{ workspaceRef: input.workspaceRef }]),
      ]);
      await prepare(input.organizationId);
      const prior = await held(input.organizationId, input.reference);
      if (prior) {
        if (prior.money_policy !== "usd-micros-v2") orgBillingFail("reference_conflict", 409);
        if (prior.fingerprint !== signature) orgBillingFail("reference_conflict", 409);
        return current(prior);
      }
      if (options.requireWorkspaceAttribution === true && input.workspaceRef === undefined)
        orgBillingFail("invalid_reference", 400);
      const structured = await workspaceOperation(workspaceAttributionSchemaReady(sql));
      if (input.workspaceRef !== undefined) {
        if (!structured) orgBillingFail("billing_schema_not_ready", 503);
        await workspaceOperation(
          assertWorkspaceOwner(sql, input.organizationId, input.workspaceRef),
        );
      }
      const tariff = await tariffAt(now());
      if (!tariff || input.pricingRevision !== tariff.revision)
        orgBillingFail("pricing_revision_unavailable", 409);
      if (
        (
          await sql.query(
            "SELECT 1 FROM org_wallet_usage_records WHERE org_id = ? AND state = 'pending' LIMIT 1",
            [input.organizationId],
          )
        ).length
      )
        orgBillingFail("outstanding_usage", 409);
      if (
        refundSchema &&
        (
          await sql.query(
            "SELECT 1 FROM stripe_billing_refunds WHERE org_id = ? AND receivable_micros > 0 LIMIT 1",
            [input.organizationId],
          )
        ).length
      )
        orgBillingFail("refund_receivable", 409);
      const admission = options.limitPolicy
        ? await workspaceOperation(options.limitPolicy.prepareAdmission(input.organizationId))
        : undefined;
      if (admission && !structured) orgBillingFail("billing_schema_not_ready", 503);
      const admissionJson = admission ? admissionWitness(admission) : undefined;
      const instant = now();
      const expiresAt = new Date(Date.parse(instant) + tariff.holdTtlSeconds * 1000).toISOString();
      const ledgerRef = `org-hold:${input.reference}`;
      const admissionGuard = `guard_${crypto.randomUUID()}`;
      try {
        const allocation =
          input.amountMicros === 0
            ? []
            : await prepareLedgerAllocation(sql, {
                organizationId: input.organizationId,
                type: "hold",
                reference: ledgerRef,
                amountMicros: input.amountMicros,
                settledDeltaMicros: 0,
                heldDeltaMicros: input.amountMicros,
                now: instant,
                hostedPaidFreeExclusion,
                ...(admission ? { allocationAdmission: admission } : {}),
              });
        const summaryRead = structured
          ? orgUsageSummaryReadStatement({
              organizationId: input.organizationId,
              instant,
              hostedPaidFreeExclusion,
            })
          : undefined;
        await sql.batch([
          ...(admission && input.amountMicros === 0 ? [admission.guard] : []),
          ...(input.workspaceRef === undefined
            ? []
            : [workspaceBindingStatement(input.organizationId, input.workspaceRef, instant)]),
          {
            sql: summaryRead
              ? `WITH summary AS (${summaryRead.sql})
                INSERT INTO org_wallet_holds (org_id, ref, ledger_ref, amount_micros, fingerprint, pricing_revision, created_at, expires_at, state, money_policy, workspace_ref, attribution_period_start, attribution_period_end${admissionJson === undefined ? "" : ", admission_policy_json"})
                SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'live', 'usd-micros-v2', ?, COALESCE(paid_start, ?), COALESCE(paid_end, snapshot_end)${admissionJson === undefined ? "" : ", ?"} FROM summary
                WHERE paid_count <= 1 AND pending_fence = 0
                  ${input.workspaceRef === undefined ? "" : "AND EXISTS (SELECT 1 FROM org_wallet_workspace_bindings WHERE org_id = ? AND workspace_ref = ?)"}`
              : `INSERT INTO org_wallet_holds (org_id, ref, ledger_ref, amount_micros, fingerprint, pricing_revision, created_at, expires_at, state, money_policy)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', 'usd-micros-v2')`,
            params: [
              ...(summaryRead?.params ?? []),
              input.organizationId,
              input.reference,
              ledgerRef,
              input.amountMicros,
              signature,
              input.pricingRevision,
              instant,
              expiresAt,
              ...(summaryRead
                ? [
                    input.workspaceRef ?? null,
                    `${instant.slice(0, 7)}-01T00:00:00.000Z`,
                    ...(admissionJson === undefined ? [] : [admissionJson]),
                    ...(input.workspaceRef === undefined
                      ? []
                      : [input.organizationId, input.workspaceRef]),
                  ]
                : []),
            ],
          },
          guard(
            admissionGuard,
            `changes() = 1 AND NOT EXISTS (SELECT 1 FROM org_wallet_usage_records WHERE org_id = ? AND state = 'pending')
             ${refundSchema ? "AND NOT EXISTS (SELECT 1 FROM stripe_billing_refunds WHERE org_id = ? AND receivable_micros > 0)" : ""}
             AND NOT EXISTS (SELECT 1 FROM ledger WHERE org_id = ? AND ref = ? AND type IN ('hold', 'capture', 'release'))`,
            refundSchema
              ? [input.organizationId, input.organizationId, input.organizationId, ledgerRef]
              : [input.organizationId, input.organizationId, ledgerRef],
          ),
          ...allocation,
          ...usageWarningStatements(input.organizationId, instant),
          { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [admissionGuard] },
          ...(admission && input.amountMicros === 0 ? [admission.cleanup] : []),
        ]);
      } catch (error) {
        const replay = await held(input.organizationId, input.reference);
        if (replay) {
          if (replay.money_policy !== "usd-micros-v2") orgBillingFail("reference_conflict", 409);
          if (replay.fingerprint !== signature) orgBillingFail("reference_conflict", 409);
          return service.readHold(input.organizationId, input.reference);
        }
        if (input.workspaceRef !== undefined)
          await workspaceOperation(
            assertWorkspaceOwner(sql, input.organizationId, input.workspaceRef),
          );
        if (admission) await assertAdmissionCurrent(sql, input.organizationId, admission);
        if (
          (
            await sql.query(
              "SELECT 1 FROM org_wallet_usage_records WHERE org_id = ? AND state = 'pending' LIMIT 1",
              [input.organizationId],
            )
          ).length
        )
          orgBillingFail("outstanding_usage", 409);
        if (
          (error instanceof LedgerError && error.code === "insufficient_funds") ||
          (error instanceof SqlError &&
            error.code === "constraint" &&
            (await ledger.wallet(input.organizationId)).availableMicros < input.amountMicros)
        )
          orgBillingFail("insufficient_funds", 402);
        if (error instanceof SqlError) orgBillingFail("billing_unavailable", 503);
        throw error;
      }
      return service.readHold(input.organizationId, input.reference);
    },
    async readHold(org, ref) {
      reference(ref);
      await prepare(org);
      const row = await held(org, ref);
      if (!row) orgBillingFail("hold_not_found", 404);
      return current(row);
    },
    async capture(input) {
      reference(input.reference);
      spendableMicros(input.amountMicros);
      fingerprint(input.measurementFingerprint);
      decimalInteger(input.actualMicros);
      const signature = JSON.stringify([
        input.amountMicros,
        input.actualMicros,
        input.measurementFingerprint,
      ]);
      await prepare(input.organizationId);
      const row = await held(input.organizationId, input.reference);
      if (!row) orgBillingFail("hold_not_found", 404);
      if (row.money_policy !== "usd-micros-v2") orgBillingFail("reference_conflict", 409);
      if (input.amountMicros > Number(row.amount_micros))
        orgBillingFail("capture_exceeds_hold", 409);
      if (row.capture_fingerprint !== null && row.state !== "live") {
        if (row.capture_fingerprint !== signature) orgBillingFail("reference_conflict", 409);
        return holdReceipt(row);
      }
      if (row.state !== "live") orgBillingFail("hold_closed", 409);
      const actual = BigInt(input.actualMicros);
      const cappedActual =
        actual > BigInt(Number(row.amount_micros)) ? Number(row.amount_micros) : Number(actual);
      if (input.amountMicros !== cappedActual) orgBillingFail("measurement_conflict", 409);
      return close(
        row,
        input.amountMicros === 0 ? "released" : "captured",
        input.amountMicros,
        signature,
        input.actualMicros,
      );
    },
    async release(org, ref) {
      reference(ref);
      await prepare(org);
      const row = await held(org, ref);
      if (row) {
        if (row.money_policy !== "usd-micros-v2") orgBillingFail("reference_conflict", 409);
        return row.state === "live" ? close(row, "released", 0) : holdReceipt(row);
      }
      const instant = now();
      try {
        await sql.run(
          `INSERT INTO org_wallet_holds (org_id, ref, ledger_ref, amount_micros, created_at, state, closed_at, money_policy)
                       VALUES (?, ?, ?, 0, ?, 'released', ?, 'usd-micros-v2')`,
          [org, ref, `org-hold:${ref}`, instant, instant],
        );
      } catch (error) {
        if (!(error instanceof SqlError && error.code === "constraint")) throw error;
        const winner = await held(org, ref);
        if (!winner) orgBillingFail("billing_unavailable", 503);
        if (winner.money_policy !== "usd-micros-v2") orgBillingFail("reference_conflict", 409);
        return winner.state === "live" ? close(winner, "released", 0) : holdReceipt(winner);
      }
      const tombstone = await held(org, ref);
      if (!tombstone) orgBillingFail("billing_unavailable", 503);
      return holdReceipt(tombstone);
    },
    async usage(input) {
      const refundSchema = await refundsReady();
      reference(input.reference);
      fingerprint(input.measurementFingerprint);
      spendableMicros(input.expectedMicros);
      const quantity = decimalQuantity(input.quantity);
      canonicalTime(input.periodStart);
      canonicalTime(input.periodEnd);
      if (input.periodStart >= input.periodEnd || input.periodEnd > now())
        orgBillingFail("invalid_usage_period", 400);
      if (input.workspaceRef !== undefined) workspaceReference(input.workspaceRef);
      const signature = JSON.stringify([
        input.meter,
        input.quantity,
        input.quantityUnit,
        input.periodStart,
        input.periodEnd,
        input.pricingRevision,
        input.expectedMicros,
        input.measurementFingerprint,
        ...(input.workspaceRef === undefined ? [] : [{ workspaceRef: input.workspaceRef }]),
      ]);
      await prepare(input.organizationId);
      let row = await usageRow(input.organizationId, input.reference);
      if (row && row.money_policy !== "usd-micros-v2") orgBillingFail("reference_conflict", 409);
      if (row && row.fingerprint !== signature) orgBillingFail("reference_conflict", 409);
      if (!row) {
        if (options.requireWorkspaceAttribution === true && input.workspaceRef === undefined)
          orgBillingFail("invalid_reference", 400);
        const structured = await workspaceOperation(workspaceAttributionSchemaReady(sql));
        if (input.workspaceRef !== undefined) {
          if (!structured) orgBillingFail("billing_schema_not_ready", 503);
          await workspaceOperation(
            assertWorkspaceOwner(sql, input.organizationId, input.workspaceRef),
          );
        }
        if (
          refundSchema &&
          (
            await sql.query(
              "SELECT 1 FROM stripe_billing_refunds WHERE org_id = ? AND receivable_micros > 0 LIMIT 1",
              [input.organizationId],
            )
          ).length
        )
          orgBillingFail("refund_receivable", 409);
        const tariff = await tariffAt(input.periodStart);
        const meter =
          tariff && Object.hasOwn(tariff.meters, input.meter)
            ? tariff.meters[input.meter]
            : undefined;
        if (!meter || !tariff || input.pricingRevision !== tariff.revision)
          orgBillingFail("pricing_revision_unavailable", 409);
        if (
          (
            await sql.query(
              "SELECT 1 FROM org_wallet_pricing_revisions WHERE effective_at > ? AND effective_at < ? LIMIT 1",
              [input.periodStart, input.periodEnd],
            )
          ).length
        )
          orgBillingFail("usage_period_crosses_tariff", 409);
        const attribution = structured
          ? await workspaceOperation(
              measuredAttributionInterval({
                sql,
                organizationId: input.organizationId,
                periodStart: input.periodStart,
                periodEnd: input.periodEnd,
                hostedPaidFreeExclusion,
              }),
            )
          : undefined;
        const byteHours = meter.unit === "byte-hour";
        if (
          byteHours
            ? input.quantityUnit !== "byte-millisecond" || quantity.denominator !== 1n
            : input.quantityUnit !== meter.unit
        )
          orgBillingFail("invalid_quantity", 400);
        const unitDenominator = byteHours ? 3600000n : 1n;
        let amount: number;
        try {
          amount = computeMeterAmountMicros(
            quantity.numerator,
            meter.rate,
            quantity.denominator * unitDenominator,
          );
        } catch (error) {
          if (error instanceof BillingConfigError) orgBillingFail("invalid_amount", 400);
          throw error;
        }
        if (amount !== input.expectedMicros) orgBillingFail("measurement_conflict", 409);
        const admission = options.limitPolicy
          ? await workspaceOperation(options.limitPolicy.prepareAdmission(input.organizationId))
          : undefined;
        if (admission && !structured) orgBillingFail("billing_schema_not_ready", 503);
        const admissionJson = admission ? admissionWitness(admission) : undefined;
        try {
          const instant = now();
          const intervalRead = attribution
            ? measuredAttributionStatement({
                organizationId: input.organizationId,
                periodStart: input.periodStart,
                periodEnd: input.periodEnd,
                hostedPaidFreeExclusion,
              })
            : undefined;
          const insert: SqlStatement = {
            sql: `${intervalRead ? `WITH interval AS (${intervalRead.sql})` : ""}
                     INSERT INTO org_wallet_usage_records (org_id, ref, fingerprint, pricing_revision, meter, quantity, quantity_unit, period_start, period_end, rate_numerator_micros, rate_denominator, amount_micros, state, created_at, money_policy${attribution ? ", workspace_ref, attribution_period_start, attribution_period_end" : ""}${admissionJson === undefined ? "" : ", admission_policy_json"})
                         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'usd-micros-v2'${attribution ? ", ?, interval.period_start, interval.period_end" : ""}${admissionJson === undefined ? "" : ", ?"}${attribution ? " FROM interval" : ""}
                         WHERE 1 = 1 ${attribution ? "AND interval.period_count <= 1 AND interval.crosses = 0" : ""}
                         ${refundSchema ? "AND NOT EXISTS (SELECT 1 FROM stripe_billing_refunds WHERE org_id = ? AND receivable_micros > 0)" : ""}
                         ${input.workspaceRef === undefined ? "" : "AND EXISTS (SELECT 1 FROM org_wallet_workspace_bindings WHERE org_id = ? AND workspace_ref = ?)"}`,
            params: [
              ...(intervalRead?.params ?? []),
              input.organizationId,
              input.reference,
              signature,
              tariff.revision,
              input.meter,
              input.quantity,
              input.quantityUnit,
              input.periodStart,
              input.periodEnd,
              meter.rate.numeratorMicros,
              meter.rate.denominator,
              amount,
              instant,
              ...(attribution ? [input.workspaceRef ?? null] : []),
              ...(admissionJson === undefined ? [] : [admissionJson]),
              ...(refundSchema ? [input.organizationId] : []),
              ...(input.workspaceRef === undefined
                ? []
                : [input.organizationId, input.workspaceRef]),
            ],
          };
          const pendingGuard = `guard_${crypto.randomUUID()}`;
          await sql.batch([
            ...(admission ? [admission.guard] : []),
            ...(input.workspaceRef === undefined
              ? []
              : [workspaceBindingStatement(input.organizationId, input.workspaceRef, instant)]),
            insert,
            guard(pendingGuard, "changes() = 1"),
            { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [pendingGuard] },
            ...(admission ? [admission.cleanup] : []),
          ]);
        } catch (error) {
          // The pending row may have committed even when its batch ACK was lost.
          // Read its immutable receipt before deciding whether insertion failed.
          if (!(error instanceof SqlError)) throw error;
        }
        row = await usageRow(input.organizationId, input.reference);
        if (!row && admission) await assertAdmissionCurrent(sql, input.organizationId, admission);
        if (!row && input.workspaceRef !== undefined)
          await workspaceOperation(
            assertWorkspaceOwner(sql, input.organizationId, input.workspaceRef),
          );
        if (
          !row &&
          refundSchema &&
          (
            await sql.query(
              "SELECT 1 FROM stripe_billing_refunds WHERE org_id = ? AND receivable_micros > 0 LIMIT 1",
              [input.organizationId],
            )
          ).length
        )
          orgBillingFail("refund_receivable", 409);
        if (!row && attribution)
          await workspaceOperation(
            measuredAttributionInterval({
              sql,
              organizationId: input.organizationId,
              periodStart: input.periodStart,
              periodEnd: input.periodEnd,
              hostedPaidFreeExclusion,
            }),
          );
        if (!row) orgBillingFail("billing_unavailable", 503);
        if (row.money_policy !== "usd-micros-v2") orgBillingFail("reference_conflict", 409);
        if (row.fingerprint !== signature) orgBillingFail("reference_conflict", 409);
      }
      if (row.state === "paid") return usageReceipt(row);
      if (
        refundSchema &&
        (
          await sql.query(
            "SELECT 1 FROM stripe_billing_refunds WHERE org_id = ? AND receivable_micros > 0 LIMIT 1",
            [input.organizationId],
          )
        ).length
      )
        orgBillingFail("refund_receivable", 409);
      const amount = Number(row.amount_micros);
      const pinnedAdmission = pinnedUsageAdmission(row, options.limitPolicy !== undefined);
      const instant = now();
      try {
        const allocation =
          amount === 0
            ? []
            : await prepareLedgerAllocation(sql, {
                organizationId: input.organizationId,
                type: "usage_debit",
                reference: `org-usage:${input.reference}`,
                amountMicros: amount,
                settledDeltaMicros: -amount,
                heldDeltaMicros: 0,
                now: instant,
                hostedPaidFreeExclusion,
                ...(pinnedAdmission ? { allocationAdmission: pinnedAdmission } : {}),
              });
        const guardId = `guard_${crypto.randomUUID()}`;
        await sql.batch([
          ...(pinnedAdmission && amount === 0 ? [pinnedAdmission.guard] : []),
          {
            sql: "UPDATE org_wallet_usage_records SET state = 'paid', paid_at = ? WHERE org_id = ? AND ref = ? AND state = 'pending'",
            params: [instant, input.organizationId, input.reference],
          },
          guard(
            guardId,
            `changes() = 1 ${refundSchema ? "AND NOT EXISTS (SELECT 1 FROM stripe_billing_refunds WHERE org_id = ? AND receivable_micros > 0)" : ""}`,
            refundSchema ? [input.organizationId] : [],
          ),
          ...allocation,
          ...usageWarningStatements(input.organizationId, instant),
          { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [guardId] },
          ...(pinnedAdmission && amount === 0 ? [pinnedAdmission.cleanup] : []),
        ]);
      } catch (error) {
        const replay = await usageRow(input.organizationId, input.reference);
        if (replay?.state === "paid") return usageReceipt(replay);
        if (error instanceof LedgerError && error.code === "insufficient_funds") {
          if (!replay) orgBillingFail("billing_unavailable", 503);
          return usageReceipt(replay);
        }
        if (
          error instanceof SqlError &&
          error.code === "constraint" &&
          (await ledger.wallet(input.organizationId)).availableMicros < amount
        ) {
          if (!replay) orgBillingFail("billing_unavailable", 503);
          return usageReceipt(replay);
        }
        if (error instanceof SqlError) orgBillingFail("billing_unavailable", 503);
        throw error;
      }
      const paid = await usageRow(input.organizationId, input.reference);
      if (!paid) orgBillingFail("billing_unavailable", 503);
      return usageReceipt(paid);
    },
    async listUsage(org, limit = 100, cursor) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        orgBillingFail("invalid_limit", 400);
      let after: [string, string] | undefined;
      if (cursor !== undefined) {
        if (cursor.length > 512) orgBillingFail("invalid_cursor", 400);
        const decoded = base64UrlDecode(cursor);
        if (!decoded) orgBillingFail("invalid_cursor", 400);
        try {
          const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decoded),
          );
          if (
            !Array.isArray(value) ||
            value.length !== 2 ||
            typeof value[0] !== "string" ||
            typeof value[1] !== "string"
          )
            orgBillingFail("invalid_cursor", 400);
          canonicalTime(value[0]);
          reference(value[1]);
          after = [value[0], value[1]];
        } catch {
          orgBillingFail("invalid_cursor", 400);
        }
      }
      await prepare(org);
      const rows = await sql.query(
        `SELECT * FROM org_wallet_usage_records WHERE org_id = ? ${after ? "AND (created_at < ? OR (created_at = ? AND ref < ?))" : ""} ORDER BY created_at DESC, ref DESC LIMIT ?`,
        after ? [org, after[0], after[0], after[1], limit + 1] : [org, limit + 1],
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        usageRecords: page.map(usageReceipt),
        cursor:
          rows.length > limit && last
            ? base64UrlEncode(new TextEncoder().encode(JSON.stringify([last.created_at, last.ref])))
            : null,
      };
    },
    async expireDue(limit, org) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        orgBillingFail("invalid_limit", 400);
      return sweep(limit, now(), org);
    },
  };
  return service;
}

function guard(
  id: string,
  condition: string,
  params: readonly (string | number)[] = [],
): SqlStatement {
  return {
    sql: `INSERT INTO wallet_allocation_guards (id, valid) VALUES (?, CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
    params: [id, ...params],
  };
}
function entry(
  org: string,
  type: "capture" | "release",
  ref: string,
  settled: number,
  held: number,
  instant: string,
): SqlStatement {
  return {
    sql: "INSERT INTO ledger (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    params: [`led_${crypto.randomUUID()}`, org, type, ref, settled, held, instant],
  };
}
function holdReceipt(row: Row): HoldReceipt {
  return {
    organizationId: String(row.org_id),
    reference: String(row.ref),
    workspaceRef: nullable(row.workspace_ref),
    attributionPeriodStart: nullable(row.attribution_period_start),
    attributionPeriodEnd: nullable(row.attribution_period_end),
    moneyPolicy: row.money_policy as MoneyPolicy,
    amountMicros: Number(row.amount_micros),
    pricingRevision: nullable(row.pricing_revision),
    status: row.state as HoldReceipt["status"],
    capturedMicros: Number(row.captured_micros),
    releasedMicros: Number(row.released_micros),
    actualMicros: nullable(row.actual_micros),
    createdAt: String(row.created_at),
    expiresAt: nullable(row.expires_at),
    closedAt: nullable(row.closed_at),
    closureReason: nullable(row.closure_reason),
  };
}
function usageReceipt(row: Row): UsageReceipt {
  return {
    organizationId: String(row.org_id),
    reference: String(row.ref),
    workspaceRef: nullable(row.workspace_ref),
    attributionPeriodStart: nullable(row.attribution_period_start),
    attributionPeriodEnd: nullable(row.attribution_period_end),
    moneyPolicy: row.money_policy as MoneyPolicy,
    pricingRevision: String(row.pricing_revision),
    meter: String(row.meter),
    quantity: String(row.quantity),
    quantityUnit: String(row.quantity_unit),
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    rate: {
      numeratorMicros: String(row.rate_numerator_micros),
      denominator: String(row.rate_denominator),
    },
    amountMicros: Number(row.amount_micros),
    status: row.state as UsageReceipt["status"],
    createdAt: String(row.created_at),
    paidAt: nullable(row.paid_at),
  };
}
function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}
function orgBillingFail(code: string, status: number): never {
  throw new OrgBillingError(code, status);
}
function spendableMicros(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) orgBillingFail("invalid_amount", 400);
}
function checkedGrantMicros(cents: number): number {
  try {
    return minorToMicros(cents);
  } catch (error) {
    if (error instanceof MoneyError) orgBillingFail("billing_unavailable", 503);
    throw error;
  }
}
function lotClassRank(value: string): number {
  if (value === "free") return 0;
  if (value === "subscription") return 1;
  if (value === "purchased") return 2;
  orgBillingFail("billing_unavailable", 503);
}
function reference(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value))
    orgBillingFail("invalid_reference", 400);
}
function fingerprint(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    orgBillingFail("invalid_fingerprint", 400);
}
function decimalInteger(value: string): void {
  if (typeof value !== "string" || value.length > 256 || !/^(0|[1-9][0-9]*)$/u.test(value))
    orgBillingFail("invalid_amount", 400);
}
function decimalQuantity(value: string): { numerator: bigint; denominator: bigint } {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]{0,17}[1-9])?$/u.test(value)
  )
    orgBillingFail("invalid_quantity", 400);
  const [whole = "0", fraction = ""] = value.split(".");
  return { numerator: BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length) };
}
function canonicalTime(value: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    orgBillingFail("invalid_usage_period", 400);
}

function workspaceReference(value: string): void {
  try {
    validateWorkspaceRef(value);
  } catch (error) {
    if (error instanceof OrgWorkspaceUsageError)
      orgBillingFail(
        error.code === "invalid_workspace_ref" ? "invalid_reference" : error.code,
        error.status,
      );
    throw error;
  }
}
async function workspaceOperation<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof OrgWorkspaceUsageError || error instanceof OrgLimitPolicyError)
      orgBillingFail(
        error.code === "invalid_workspace_ref" ? "invalid_reference" : error.code,
        error.status,
      );
    if (error instanceof OrgUsageSummaryUnavailable || error instanceof SqlError)
      orgBillingFail("billing_unavailable", 503);
    throw error;
  }
}

function admissionWitness(admission: OrgLimitAdmission): string {
  return canonicalJson({
    onLimit: admission.onLimit,
    policyVersion: admission.policyVersion,
    consentRevision: admission.consentRevision,
    allowPurchasedCredit: admission.allowPurchasedCredit,
  });
}
async function assertAdmissionCurrent(
  sql: Sql,
  org: string,
  admission: OrgLimitAdmission,
): Promise<void> {
  const row = (
    await sql.query(
      "SELECT COALESCE((SELECT policy_version FROM org_wallet_limit_policies WHERE org_id = ?), 0) AS version",
      [org],
    )
  )[0];
  if (!row || row.version !== admission.policyVersion) orgBillingFail("conflict", 409);
}
function pinnedUsageAdmission(
  row: Row,
  conservativeLegacyAdmission: boolean,
):
  | {
      readonly allowPurchasedCredit: boolean;
      readonly guard: SqlStatement;
      readonly cleanup: SqlStatement;
    }
  | undefined {
  if (row.admission_policy_json == null) {
    if (!conservativeLegacyAdmission) return undefined;
    // Legacy pending usage proves consumption, but has no immutable purchase
    // consent. Hosted can settle it from included credit without inventing one.
    const id = `guard_${crypto.randomUUID()}`;
    return {
      allowPurchasedCredit: false,
      guard: guard(
        id,
        "EXISTS (SELECT 1 FROM org_wallet_usage_records WHERE org_id = ? AND ref = ? AND admission_policy_json IS NULL)",
        [String(row.org_id), String(row.ref)],
      ),
      cleanup: { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [id] },
    };
  }
  let witness: unknown;
  try {
    witness = JSON.parse(String(row.admission_policy_json));
  } catch {
    orgBillingFail("billing_unavailable", 503);
  }
  if (!witness || typeof witness !== "object" || Array.isArray(witness))
    orgBillingFail("billing_unavailable", 503);
  const p = witness as Record<string, unknown>;
  if (
    (p.onLimit !== "stop" && p.onLimit !== "prepaid") ||
    typeof p.policyVersion !== "number" ||
    !Number.isSafeInteger(p.policyVersion) ||
    p.policyVersion < 0 ||
    (p.consentRevision !== null && typeof p.consentRevision !== "string") ||
    typeof p.allowPurchasedCredit !== "boolean" ||
    p.allowPurchasedCredit !== (p.onLimit === "prepaid")
  )
    orgBillingFail("billing_unavailable", 503);
  const id = `guard_${crypto.randomUUID()}`;
  return {
    allowPurchasedCredit: p.allowPurchasedCredit,
    guard: guard(
      id,
      "EXISTS (SELECT 1 FROM org_wallet_usage_records WHERE org_id = ? AND ref = ? AND admission_policy_json = ?)",
      [String(row.org_id), String(row.ref), String(row.admission_policy_json)],
    ),
    cleanup: { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [id] },
  };
}
