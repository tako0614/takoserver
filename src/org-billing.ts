import {
  type BillingConfig,
  BillingConfigError,
  computeMeterAmountMinor,
  parseBillingConfig,
  roundMicrosToMinor,
} from "./billing-config.ts";
import { base64UrlDecode, base64UrlEncode, bytesDigest, canonicalJson } from "./json.ts";
import { type Ledger, LedgerError, prepareLedgerAllocation, type Wallet } from "./ledger.ts";
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
  readonly amountMinor: number;
  readonly pricingRevision: string | null;
  readonly status: "live" | "captured" | "released" | "expired";
  readonly capturedMinor: number;
  readonly releasedMinor: number;
  readonly actualMicros: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly closedAt: string | null;
}

export interface UsageReceipt {
  readonly organizationId: string;
  readonly reference: string;
  readonly pricingRevision: string;
  readonly meter: string;
  readonly quantity: string;
  readonly quantityUnit: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly rate: { readonly numeratorMicros: string; readonly denominator: string };
  readonly amountMinor: number;
  readonly status: "pending" | "paid";
  readonly createdAt: string;
  readonly paidAt: string | null;
}

export interface CreditLot {
  readonly reference: string;
  readonly kind: "direct" | "plan-included" | "purchased";
  readonly amountMinor: number;
  readonly spentMinor: number;
  readonly remainingMinor: number;
  readonly heldMinor: number;
  readonly availableMinor: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface HoldInput {
  readonly organizationId: string;
  readonly reference: string;
  readonly amountMinor: number;
  readonly pricingRevision: string;
  readonly measurementFingerprint: string;
}

export interface CaptureInput {
  readonly organizationId: string;
  readonly reference: string;
  readonly amountMinor: number;
  readonly actualMicros: string;
  readonly measurementFingerprint: string;
}

export interface UsageInput {
  readonly organizationId: string;
  readonly reference: string;
  readonly meter: string;
  readonly quantity: string;
  readonly quantityUnit: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly pricingRevision: string;
  readonly expectedMinor: number;
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
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('org_wallet_holds', 'org_wallet_usage_records', 'org_wallet_grant_snapshots', 'org_wallet_pricing_revisions', 'org_wallet_monthly_tariffs')",
  );
  if (rows.length !== 5) throw new OrgBillingError("billing_schema_not_ready", 503);
  const cursorObjects = await sql.query(
    "SELECT name FROM sqlite_schema WHERE (type = 'index' AND name = 'wallet_credit_lots_cursor') OR (type = 'trigger' AND name IN ('wallet_credit_lots_cursor_insert', 'wallet_credit_lots_cursor_immutable'))",
  );
  if (cursorObjects.length !== 3) throw new OrgBillingError("billing_schema_not_ready", 503);
  if (config) await registerTariffs(sql, config, clock().toISOString());
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
}): OrgBilling {
  const { sql, clock, ledger, config } = options;
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

  async function prepare(org: string): Promise<void> {
    await registerTariffs(sql, config, now());
    await service.expireDue(8, org);
    if (
      (
        await sql.query(
          "SELECT 1 FROM org_wallet_holds WHERE org_id = ? AND state = 'live' AND expires_at <= ? LIMIT 1",
          [org, now()],
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
      `INSERT OR IGNORE INTO org_wallet_monthly_tariffs (month, pricing_revision, amount_minor, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      [
        month,
        monthly?.revision ?? "unconfigured",
        monthly?.freeIncludedMinor ?? 0,
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
      `INSERT OR IGNORE INTO org_wallet_grant_snapshots (org_id, ref, pricing_revision, amount_minor, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        org,
        ref,
        String(policy.pricing_revision),
        Number(policy.amount_minor),
        String(policy.expires_at),
        instant,
      ],
    );
    const snapshot = (
      await sql.query(
        "SELECT amount_minor, expires_at FROM org_wallet_grant_snapshots WHERE org_id = ? AND ref = ?",
        [org, ref],
      )
    )[0];
    if (!snapshot) orgBillingFail("billing_unavailable", 503);
    if (Number(snapshot.amount_minor) > 0)
      await ledger.fund({
        organizationId: org,
        fundingRef: ref,
        amountMinor: Number(snapshot.amount_minor),
        kind: "plan-included",
        expiresAt: String(snapshot.expires_at),
      });
  }

  async function close(
    row: Row,
    state: "captured" | "released" | "expired",
    captured: number,
    captureFingerprint: string | null = null,
    actualMicros: string | null = null,
  ): Promise<HoldReceipt> {
    const org = String(row.org_id);
    const ref = String(row.ref);
    const ledgerRef = String(row.ledger_ref);
    const amount = Number(row.amount_minor);
    const instant = now();
    const guards: SqlStatement[] = [];
    const guardId = `guard_${crypto.randomUUID()}`;
    guards.push(
      {
        sql: `UPDATE org_wallet_holds SET state = ?, captured_minor = ?, released_minor = ?,
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
    // Also fence the precise original hold. Other internal ledger callers may
    // not partially settle a public lifecycle behind its durable state row.
    guards.push(
      guard(
        `${guardId}_hold`,
        `
      (SELECT COALESCE(SUM(held_delta), 0) FROM ledger WHERE org_id = ? AND ref = ?) = ?
      AND (SELECT COALESCE(SUM(amount_minor), 0) FROM wallet_credit_allocations
           WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?) = ?
      AND NOT EXISTS (SELECT 1 FROM ledger WHERE org_id = ? AND ref = ? AND type IN ('capture', 'release'))`,
        [org, ledgerRef, amount, org, ledgerRef, amount, org, ledgerRef],
      ),
    );
    const allocations = await sql.query(
      `SELECT a.lot_ref, a.amount_minor FROM wallet_credit_allocations a
       JOIN wallet_credit_lots l ON l.org_id = a.org_id AND l.ref = a.lot_ref
       WHERE a.org_id = ? AND a.debit_type = 'hold' AND a.debit_ref = ?
       ORDER BY CASE WHEN l.expires_at IS NULL THEN 1 ELSE 0 END, l.expires_at, l.created_at, l.ref`,
      [org, ledgerRef],
    );
    let remaining = captured;
    for (const allocation of allocations) {
      const used = Math.min(remaining, Number(allocation.amount_minor));
      if (used > 0)
        guards.push({
          sql: `INSERT INTO wallet_credit_allocations (org_id, debit_type, debit_ref, lot_ref, amount_minor, created_at)
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
    guards.push({
      sql: "DELETE FROM wallet_allocation_guards WHERE id IN (?, ?)",
      params: [guardId, `${guardId}_hold`],
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

  const service: OrgBilling = {
    async wallet(org) {
      await prepare(org);
      return ledger.wallet(org);
    },
    async lots(org, limit = 100, cursor) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        orgBillingFail("invalid_limit", 400);
      let after: Row | undefined;
      if (cursor !== undefined) {
        if (!/^[a-f0-9]{32}$/u.test(cursor)) orgBillingFail("invalid_cursor", 400);
        // A random stable handle supports arbitrarily long pre-existing refs.
        // Resolve only in this Organization; the cursor never grants access.
        after = (
          await sql.query(
            "SELECT ref, expires_at, created_at FROM wallet_credit_lots WHERE org_id = ? AND cursor_handle = ?",
            [org, cursor],
          )
        )[0];
        if (!after) orgBillingFail("invalid_cursor", 400);
      }
      await prepare(org);
      const nullableRank = after?.expires_at == null ? 1 : 0;
      const boundary = after
        ? `AND (
        CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END > ? OR
        (CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END = ? AND
         (COALESCE(expires_at, '') > ? OR
          (COALESCE(expires_at, '') = ? AND
           (created_at > ? OR (created_at = ? AND ref > ?))))))`
        : "";
      const rows = await sql.query(
        `SELECT l.*,
          COALESCE(SUM(CASE WHEN a.debit_type = 'hold' THEN a.amount_minor ELSE 0 END), 0) AS held_minor,
          COALESCE(SUM(CASE WHEN a.debit_type IN ('capture', 'usage_debit') THEN a.amount_minor ELSE 0 END), 0) AS spent_minor
         FROM (SELECT * FROM wallet_credit_lots WHERE org_id = ? ${boundary}
           ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at, created_at, ref LIMIT ?) l
         LEFT JOIN wallet_credit_allocations a ON a.org_id = l.org_id AND a.lot_ref = l.ref
         GROUP BY l.org_id, l.ref
         ORDER BY CASE WHEN l.expires_at IS NULL THEN 1 ELSE 0 END, l.expires_at, l.created_at, l.ref`,
        after
          ? [
              org,
              nullableRank,
              nullableRank,
              String(after.expires_at ?? ""),
              String(after.expires_at ?? ""),
              String(after.created_at),
              String(after.created_at),
              String(after.ref),
              limit + 1,
            ]
          : [org, limit + 1],
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const lots = page.map((row) => {
        const amountMinor = Number(row.amount_minor);
        const spentMinor = Number(row.spent_minor);
        const heldMinor = Number(row.held_minor);
        const remainingMinor = amountMinor - spentMinor;
        return {
          reference: String(row.ref),
          kind: row.kind as CreditLot["kind"],
          amountMinor,
          spentMinor,
          remainingMinor,
          heldMinor,
          availableMinor:
            row.expires_at == null || String(row.expires_at) > now()
              ? remainingMinor - heldMinor
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
      reference(input.reference);
      minor(input.amountMinor);
      fingerprint(input.measurementFingerprint);
      const signature = JSON.stringify([
        input.amountMinor,
        input.pricingRevision,
        input.measurementFingerprint,
      ]);
      await prepare(input.organizationId);
      const prior = await held(input.organizationId, input.reference);
      if (prior) {
        if (prior.fingerprint !== signature) orgBillingFail("reference_conflict", 409);
        return holdReceipt(prior);
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
      const instant = now();
      const expiresAt = new Date(Date.parse(instant) + tariff.holdTtlSeconds * 1000).toISOString();
      const ledgerRef = `org-hold:${input.reference}`;
      const admissionGuard = `guard_${crypto.randomUUID()}`;
      try {
        const allocation =
          input.amountMinor === 0
            ? []
            : await prepareLedgerAllocation(sql, {
                organizationId: input.organizationId,
                type: "hold",
                reference: ledgerRef,
                amountMinor: input.amountMinor,
                settledDeltaMinor: 0,
                heldDeltaMinor: input.amountMinor,
                now: instant,
              });
        await sql.batch([
          {
            sql: `INSERT INTO org_wallet_holds (org_id, ref, ledger_ref, amount_minor, fingerprint, pricing_revision, created_at, expires_at, state)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live')`,
            params: [
              input.organizationId,
              input.reference,
              ledgerRef,
              input.amountMinor,
              signature,
              input.pricingRevision,
              instant,
              expiresAt,
            ],
          },
          guard(
            admissionGuard,
            "NOT EXISTS (SELECT 1 FROM org_wallet_usage_records WHERE org_id = ? AND state = 'pending') AND NOT EXISTS (SELECT 1 FROM ledger WHERE org_id = ? AND ref = ? AND type IN ('hold', 'capture', 'release'))",
            [input.organizationId, input.organizationId, ledgerRef],
          ),
          ...allocation,
          { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [admissionGuard] },
        ]);
      } catch (error) {
        const replay = await held(input.organizationId, input.reference);
        if (replay) {
          if (replay.fingerprint !== signature) orgBillingFail("reference_conflict", 409);
          return service.readHold(input.organizationId, input.reference);
        }
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
            (await ledger.wallet(input.organizationId)).availableMinor < input.amountMinor)
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
      if (row.state === "live" && String(row.expires_at) <= now()) return close(row, "expired", 0);
      return holdReceipt(row);
    },
    async capture(input) {
      reference(input.reference);
      minor(input.amountMinor);
      fingerprint(input.measurementFingerprint);
      decimalInteger(input.actualMicros);
      const signature = JSON.stringify([
        input.amountMinor,
        input.actualMicros,
        input.measurementFingerprint,
      ]);
      await prepare(input.organizationId);
      const row = await held(input.organizationId, input.reference);
      if (!row) orgBillingFail("hold_not_found", 404);
      if (input.amountMinor > Number(row.amount_minor)) orgBillingFail("capture_exceeds_hold", 409);
      if (row.capture_fingerprint !== null && row.state !== "live") {
        if (row.capture_fingerprint !== signature) orgBillingFail("reference_conflict", 409);
        return holdReceipt(row);
      }
      if (row.state !== "live") orgBillingFail("hold_closed", 409);
      let actual: number;
      try {
        actual = roundMicrosToMinor(input.actualMicros);
      } catch (error) {
        if (error instanceof BillingConfigError) orgBillingFail("invalid_amount", 400);
        throw error;
      }
      if (input.amountMinor !== Math.min(actual, Number(row.amount_minor)))
        orgBillingFail("measurement_conflict", 409);
      return close(
        row,
        input.amountMinor === 0 ? "released" : "captured",
        input.amountMinor,
        signature,
        input.actualMicros,
      );
    },
    async release(org, ref) {
      reference(ref);
      await prepare(org);
      const row = await held(org, ref);
      if (row) return row.state === "live" ? close(row, "released", 0) : holdReceipt(row);
      const instant = now();
      try {
        await sql.run(
          `INSERT INTO org_wallet_holds (org_id, ref, ledger_ref, amount_minor, created_at, state, closed_at)
                       VALUES (?, ?, ?, 0, ?, 'released', ?)`,
          [org, ref, `org-hold:${ref}`, instant, instant],
        );
      } catch (error) {
        if (!(error instanceof SqlError && error.code === "constraint")) throw error;
        const winner = await held(org, ref);
        if (!winner) orgBillingFail("billing_unavailable", 503);
        return winner.state === "live" ? close(winner, "released", 0) : holdReceipt(winner);
      }
      const tombstone = await held(org, ref);
      if (!tombstone) orgBillingFail("billing_unavailable", 503);
      return holdReceipt(tombstone);
    },
    async usage(input) {
      reference(input.reference);
      fingerprint(input.measurementFingerprint);
      minor(input.expectedMinor);
      const quantity = decimalQuantity(input.quantity);
      canonicalTime(input.periodStart);
      canonicalTime(input.periodEnd);
      if (input.periodStart >= input.periodEnd || input.periodEnd > now())
        orgBillingFail("invalid_usage_period", 400);
      const signature = JSON.stringify([
        input.meter,
        input.quantity,
        input.quantityUnit,
        input.periodStart,
        input.periodEnd,
        input.pricingRevision,
        input.expectedMinor,
        input.measurementFingerprint,
      ]);
      await prepare(input.organizationId);
      let row = await usageRow(input.organizationId, input.reference);
      if (row && row.fingerprint !== signature) orgBillingFail("reference_conflict", 409);
      if (!row) {
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
          amount = computeMeterAmountMinor(
            quantity.numerator,
            meter.rate,
            quantity.denominator * unitDenominator,
          );
        } catch (error) {
          if (error instanceof BillingConfigError) orgBillingFail("invalid_amount", 400);
          throw error;
        }
        if (amount !== input.expectedMinor) orgBillingFail("measurement_conflict", 409);
        try {
          await sql.run(
            `INSERT INTO org_wallet_usage_records (org_id, ref, fingerprint, pricing_revision, meter, quantity, quantity_unit, period_start, period_end, rate_numerator_micros, rate_denominator, amount_minor, state, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
            [
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
              now(),
            ],
          );
        } catch (error) {
          if (!(error instanceof SqlError && error.code === "constraint")) throw error;
        }
        row = await usageRow(input.organizationId, input.reference);
        if (!row) orgBillingFail("billing_unavailable", 503);
        if (row.fingerprint !== signature) orgBillingFail("reference_conflict", 409);
      }
      if (row.state === "paid") return usageReceipt(row);
      const amount = Number(row.amount_minor);
      const instant = now();
      try {
        const allocation =
          amount === 0
            ? []
            : await prepareLedgerAllocation(sql, {
                organizationId: input.organizationId,
                type: "usage_debit",
                reference: `org-usage:${input.reference}`,
                amountMinor: amount,
                settledDeltaMinor: -amount,
                heldDeltaMinor: 0,
                now: instant,
              });
        const guardId = `guard_${crypto.randomUUID()}`;
        await sql.batch([
          {
            sql: "UPDATE org_wallet_usage_records SET state = 'paid', paid_at = ? WHERE org_id = ? AND ref = ? AND state = 'pending'",
            params: [instant, input.organizationId, input.reference],
          },
          guard(guardId, "changes() = 1"),
          ...allocation,
          { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [guardId] },
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
          (await ledger.wallet(input.organizationId)).availableMinor < amount
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
      const rows = await sql.query(
        `SELECT * FROM org_wallet_holds WHERE state = 'live' AND expires_at <= ? ${org === undefined ? "" : "AND org_id = ?"} ORDER BY expires_at, org_id, ref LIMIT ?`,
        org === undefined ? [now(), limit] : [now(), org, limit],
      );
      for (const row of rows) await close(row, "expired", 0);
      return rows.length;
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
    sql: "INSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    params: [`led_${crypto.randomUUID()}`, org, type, ref, settled, held, instant],
  };
}
function holdReceipt(row: Row): HoldReceipt {
  return {
    organizationId: String(row.org_id),
    reference: String(row.ref),
    amountMinor: Number(row.amount_minor),
    pricingRevision: nullable(row.pricing_revision),
    status: row.state as HoldReceipt["status"],
    capturedMinor: Number(row.captured_minor),
    releasedMinor: Number(row.released_minor),
    actualMicros: nullable(row.actual_micros),
    createdAt: String(row.created_at),
    expiresAt: nullable(row.expires_at),
    closedAt: nullable(row.closed_at),
  };
}
function usageReceipt(row: Row): UsageReceipt {
  return {
    organizationId: String(row.org_id),
    reference: String(row.ref),
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
    amountMinor: Number(row.amount_minor),
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
function minor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) orgBillingFail("invalid_amount", 400);
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
