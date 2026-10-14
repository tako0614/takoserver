import { minorToMicros } from "./money.ts";
import { type Clock, type Sql, SqlError, type SqlParam, type SqlStatement } from "./ports.ts";

/**
 * The prepaid wallet.
 *
 * There is no authoritative balance column. Every figure is recomputed from an
 * append-only entry log, so a balance can never drift away from the events that
 * produced it — the worst a bug can do is fail to write an entry, which is
 * visible, rather than leave a counter quietly wrong.
 *
 * Money moves in four kinds of entry:
 *
 * | kind      | settled | held  | meaning                          |
 * |-----------|---------|-------|----------------------------------|
 * | `funding` | `+n`    | `0`   | the customer paid in             |
 * | `hold`    | `0`     | `+n`  | funds earmarked for a reservation|
 * | `capture` | `-n`    | `-n`  | the hold was spent               |
 * | `release` | `0`     | `-n`  | the hold was returned unspent    |
 *
 * `available = settled - held`. Each entry carries a reference that is unique
 * per organization and kind, so replaying any operation is a no-op by
 * construction rather than by a check someone has to remember to write.
 */

export type LedgerEntryType =
  | "funding"
  | "hold"
  | "capture"
  | "release"
  | "usage_debit"
  | "refund_debit"
  | "refund_receivable"
  | "revoked_after_expiry";
export type CreditConsumptionClass = "free" | "subscription" | "purchased";

export interface LedgerEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly type: LedgerEntryType;
  readonly reference: string;
  readonly settledDeltaMicros: number;
  readonly heldDeltaMicros: number;
  readonly createdAt: string;
}

export interface Wallet {
  readonly organizationId: string;
  readonly currency: "USD";
  readonly settledMicros: number;
  readonly heldMicros: number;
  readonly availableMicros: number;
  readonly frozenMicros: number;
  readonly refundReceivableMicros: number;
  readonly entries: readonly LedgerEntry[];
}

/**
 * Turns an opaque payment proof into an amount. The caller never states how
 * much it paid — only the verifier does, so a customer cannot credit itself by
 * asking nicely.
 */
export interface FundingSettlementVerifier {
  verify(input: { readonly organizationId: string; readonly settlementProof: string }): Promise<{
    readonly fundingRef: string;
    readonly amountMinor: number;
    readonly currency: "USD";
  }>;
}

export type LedgerErrorCode = "insufficient_funds" | "conservation_violated" | "invalid_amount";

export class LedgerError extends Error {
  constructor(readonly code: LedgerErrorCode) {
    super(code);
    this.name = "LedgerError";
  }
}

/** Most recent entries returned with a wallet; the log itself is unbounded. */
export const WALLET_ENTRY_PAGE = 100;

const stripeRefundSchemaCache = new WeakMap<Sql, Promise<boolean>>();

/** A local invoice proof is paid until its consideration is fully refunded.
 * An active refund fence also blocks a Free escape while settlement is pending.
 * Its placeholders bind the organization, both period bounds, and the fence owner. */
export const hostedPaidFreeBlockedSql = `(
  EXISTS (SELECT 1 FROM stripe_billing_grants g
    WHERE g.org_id = ? AND g.source_type = 'invoice'
      AND g.period_start <= ? AND g.period_end > ?
      AND NOT EXISTS (SELECT 1 FROM stripe_billing_refunds r
        WHERE r.org_id = g.org_id AND r.funding_ref = g.funding_ref
          AND r.cumulative_refunded_micros >= g.consideration_micros))
  OR EXISTS (SELECT 1 FROM stripe_billing_fences f
    WHERE f.org_id = ? AND f.active = 1
      AND (f.funding_ref LIKE 'stripe:invoice:%'
        OR EXISTS (SELECT 1 FROM stripe_billing_grants g
          WHERE g.org_id = f.org_id AND g.funding_ref = f.funding_ref
            AND g.source_type = 'invoice')))
)`;

export function hostedPaidFreeBlockedParams(organizationId: string, instant: string) {
  return [organizationId, instant, instant, organizationId] as const;
}

/** Legacy self-host wallets keep serving until the additive Stripe schema exists. */
export function stripeRefundSchemaReady(sql: Sql): Promise<boolean> {
  let ready = stripeRefundSchemaCache.get(sql);
  if (!ready) {
    ready = sql
      .query(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('stripe_billing_refunds', 'stripe_billing_fences')",
      )
      .then((rows) => rows.length === 2)
      .catch((error: unknown) => {
        stripeRefundSchemaCache.delete(sql);
        throw error;
      });
    stripeRefundSchemaCache.set(sql, ready);
  }
  return ready;
}

export interface Ledger {
  wallet(organizationId: string): Promise<Wallet>;
  /** Credits settled funds. Repeating a funding reference credits once. */
  fund(input: {
    readonly organizationId: string;
    readonly fundingRef: string;
    readonly amountMicros: number;
    readonly kind?: "direct" | "plan-included" | "purchased";
    readonly consumptionClass: CreditConsumptionClass;
    readonly expiresAt?: string | null;
  }): Promise<Wallet>;
  /** Whether this funding reference has already credited the organization. */
  hasFunding(input: {
    readonly organizationId: string;
    readonly fundingRef: string;
  }): Promise<boolean>;
  /**
   * The funding references, of those given, that already credited their
   * organization: one query for a whole batch, so a periodic pass does not
   * cost a query per payment it has already seen.
   */
  fundedReferences(
    entries: readonly { readonly organizationId: string; readonly fundingRef: string }[],
  ): Promise<ReadonlySet<string>>;
  /**
   * Earmarks funds. Returns false when the balance cannot cover the amount —
   * the decision is made by the insert itself, so two concurrent holds can
   * never both succeed against the same funds.
   */
  hold(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly amountMicros: number;
  }): Promise<boolean>;
  capture(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly amountMicros: number;
  }): Promise<void>;
  release(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly amountMicros: number;
  }): Promise<void>;
  /**
   * Charges metered usage directly against available prepaid funds. Returns
   * false without writing when the Wallet cannot cover the charge; replaying
   * the same exact reference and amount returns true.
   */
  debitUsage(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly amountMicros: number;
  }): Promise<boolean>;
}

/** Exact priced hold carried across an internal atomic lifecycle settlement. */
export interface LedgerHeldCharge {
  readonly reference: string;
  /** The original commercial quote in cents, not a ledger balance. */
  readonly amountMinor: number;
}

/**
 * Data-only participant for a larger SQL batch which definitively releases a
 * hold. The caller owns the surrounding lifecycle fence and transaction; this
 * participant owns only wallet conservation and exact release readback.
 */
export interface LedgerHoldReleaseParticipant {
  readonly statements: readonly SqlStatement[];
  readonly committedFence: {
    readonly sql: string;
    readonly params: readonly SqlParam[];
  };
}

export function ledgerHoldReleaseCommittedFence(
  input: { readonly organizationId: string } & LedgerHeldCharge,
): LedgerHoldReleaseParticipant["committedFence"] {
  const amountMicros = quoteMicros(input.amountMinor);
  positiveAmount(amountMicros);
  return {
    sql: `EXISTS (
            SELECT 1 FROM ledger
            WHERE org_id = ? AND type = 'hold' AND ref = ?
              AND settled_delta_micros = 0 AND held_delta_micros = ?
          )
          AND EXISTS (
            SELECT 1 FROM ledger
            WHERE org_id = ? AND type = 'release' AND ref = ?
              AND settled_delta_micros = 0 AND held_delta_micros = ?
          )
          AND (SELECT COALESCE(SUM(held_delta_micros), 0) FROM ledger
               WHERE org_id = ? AND ref = ?) = 0
          AND NOT EXISTS (
            SELECT 1 FROM wallet_credit_allocations
            WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?
          )`,
    params: [
      input.organizationId,
      input.reference,
      amountMicros,
      input.organizationId,
      input.reference,
      -amountMicros,
      input.organizationId,
      input.reference,
      input.organizationId,
      input.reference,
    ],
  };
}

export async function prepareLedgerHoldRelease(
  sql: Sql,
  clock: Clock,
  input: { readonly organizationId: string } & LedgerHeldCharge,
): Promise<LedgerHoldReleaseParticipant> {
  const amountMicros = quoteMicros(input.amountMinor);
  positiveAmount(amountMicros);
  const planned = await planHoldSettlement(
    sql,
    clock,
    input.organizationId,
    "release",
    input.reference,
    amountMicros,
  );
  return {
    statements: planned,
    committedFence: ledgerHoldReleaseCommittedFence(input),
  };
}

export function createLedger(
  sql: Sql,
  clock: Clock,
  options: { readonly hostedPaidFreeExclusion?: boolean } = {},
): Ledger {
  const hostedPaidFreeExclusion = options.hostedPaidFreeExclusion === true;
  return {
    async wallet(organizationId): Promise<Wallet> {
      const refundsReady = await stripeRefundSchemaReady(sql);
      const instant = clock().toISOString();
      const totals = await sql.query(
        `SELECT
           COALESCE((
             SELECT SUM(CASE
               WHEN (l.expires_at IS NULL OR l.expires_at > ?)
                 ${hostedPaidFreeExclusion ? `AND NOT (l.consumption_class = 'free' AND ${hostedPaidFreeBlockedSql})` : ""} THEN
                 l.amount_micros - COALESCE((
                   SELECT SUM(a.amount_micros)
                   FROM wallet_credit_allocations a
                   WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
                     AND a.debit_type IN ('capture', 'usage_debit')
                 ), 0) - ${
                   refundsReady
                     ? `COALESCE((SELECT SUM(r.debit_micros)
                   FROM stripe_billing_refunds r WHERE r.org_id = l.org_id
                     AND r.funding_ref = l.ref), 0)`
                     : "0"
}
               ELSE COALESCE((
                 SELECT SUM(a.amount_micros)
                 FROM wallet_credit_allocations a
                 WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
                   AND a.debit_type = 'hold'
               ), 0)
             END)
             FROM wallet_credit_lots l
             WHERE l.org_id = ?
           ), 0) AS settled,
           COALESCE((
             SELECT SUM(held_delta_micros) FROM ledger WHERE org_id = ?
           ), 0) AS held,
           COALESCE((
             SELECT SUM(amount_micros) FROM wallet_credit_allocations
             WHERE org_id = ? AND debit_type = 'hold'
           ), 0) AS allocated_held,
           ${
             refundsReady
               ? `COALESCE((SELECT SUM(receivable_micros) FROM stripe_billing_refunds
                         WHERE org_id = ?), 0)`
               : "0"
} AS receivable,
           ${
             refundsReady
               ? `COALESCE((SELECT SUM(MAX(0, l.amount_micros
             - COALESCE((SELECT SUM(a.amount_micros) FROM wallet_credit_allocations a
                         WHERE a.org_id = l.org_id AND a.lot_ref = l.ref), 0)
             - COALESCE((SELECT SUM(r.debit_micros) FROM stripe_billing_refunds r
                         WHERE r.org_id = l.org_id AND r.funding_ref = l.ref), 0)))
             FROM wallet_credit_lots l JOIN stripe_billing_fences f
               ON f.org_id = l.org_id AND f.funding_ref = l.ref AND f.active = 1
             WHERE l.org_id = ? AND (l.expires_at IS NULL OR l.expires_at > ?)), 0)`
               : "0"
} AS frozen`,
        refundsReady
          ? [
              instant,
              ...(hostedPaidFreeExclusion
                ? hostedPaidFreeBlockedParams(organizationId, instant)
                : []),
              organizationId,
              organizationId,
              organizationId,
              organizationId,
              organizationId,
              instant,
            ]
          : [
              instant,
              ...(hostedPaidFreeExclusion
                ? hostedPaidFreeBlockedParams(organizationId, instant)
                : []),
              organizationId,
              organizationId,
              organizationId,
            ],
      );
      const settledMicros = sqlMicros(totals[0]?.settled ?? 0);
      const heldMicros = sqlMicros(totals[0]?.held ?? 0);
      const allocatedHeldMicros = sqlMicros(totals[0]?.allocated_held ?? 0);
      const frozenMicros = sqlMicros(totals[0]?.frozen ?? 0);
      const refundReceivableMicros = sqlMicros(totals[0]?.receivable ?? 0);
      const availableMicros = settledMicros - heldMicros - frozenMicros;
      // Any of these going negative means entries were written that the rules
      // above forbid. Reporting a wrong balance would be worse than failing.
      if (
        !Number.isSafeInteger(settledMicros) ||
        !Number.isSafeInteger(heldMicros) ||
        !Number.isSafeInteger(allocatedHeldMicros) ||
        !Number.isSafeInteger(availableMicros) ||
        !Number.isSafeInteger(frozenMicros) ||
        !Number.isSafeInteger(refundReceivableMicros) ||
        settledMicros < 0 ||
        heldMicros < 0 ||
        availableMicros < 0 ||
        frozenMicros < 0 ||
        refundReceivableMicros < 0 ||
        allocatedHeldMicros !== heldMicros
      ) {
        throw new LedgerError("conservation_violated");
      }
      const rows = await sql.query(
        refundsReady
          ? `SELECT * FROM (
          SELECT id, type, ref, settled_delta_micros, held_delta_micros, created_at
            FROM ledger WHERE org_id = ?
          UNION ALL SELECT 'refund:debit:' || refund_id, 'refund_debit', refund_id,
                   -debit_micros, 0, created_at FROM stripe_billing_refunds
                   WHERE org_id = ? AND debit_micros > 0
          UNION ALL SELECT 'refund:receivable:' || refund_id, 'refund_receivable', refund_id,
                   0, 0, created_at FROM stripe_billing_refunds
                   WHERE org_id = ? AND receivable_micros > 0
          UNION ALL SELECT 'refund:expired:' || refund_id, 'revoked_after_expiry', refund_id,
                   0, 0, created_at FROM stripe_billing_refunds
                   WHERE org_id = ? AND expired_micros > 0
        ) ORDER BY created_at DESC, id DESC LIMIT ?`
          : `SELECT id, type, ref, settled_delta_micros, held_delta_micros, created_at
             FROM ledger WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        refundsReady
          ? [organizationId, organizationId, organizationId, organizationId, WALLET_ENTRY_PAGE]
          : [organizationId, WALLET_ENTRY_PAGE],
      );
      return {
        organizationId,
        currency: "USD",
        settledMicros,
        heldMicros,
        availableMicros,
        frozenMicros,
        refundReceivableMicros,
        entries: rows.map((row) => ({
          id: String(row.id),
          organizationId,
          type: String(row.type) as LedgerEntryType,
          reference: String(row.ref),
          settledDeltaMicros: sqlMicros(row.settled_delta_micros),
          heldDeltaMicros: sqlMicros(row.held_delta_micros),
          createdAt: String(row.created_at),
        })),
      };
    },

    async fund({
      organizationId,
      fundingRef,
      amountMicros,
      kind = "direct",
      consumptionClass,
      expiresAt = null,
    }): Promise<Wallet> {
      positiveAmount(amountMicros);
      if (
        !(["direct", "plan-included", "purchased"] as readonly unknown[]).includes(kind) ||
        !(["free", "subscription", "purchased"] as readonly unknown[]).includes(consumptionClass) ||
        (kind === "plan-included" && consumptionClass === "purchased") ||
        (kind === "purchased" && consumptionClass !== "purchased")
      ) {
        throw new LedgerError("invalid_amount");
      }
      if (
        expiresAt !== null &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(expiresAt) ||
          !Number.isFinite(Date.parse(expiresAt)) ||
          new Date(expiresAt).toISOString() !== expiresAt)
      ) {
        throw new LedgerError("invalid_amount");
      }
      const priorLot = await sql.query(
        `SELECT kind, consumption_class, amount_micros, expires_at
         FROM wallet_credit_lots WHERE org_id = ? AND ref = ?`,
        [organizationId, fundingRef],
      );
      const priorFunding = await sql.query(
        `SELECT settled_delta_micros, held_delta_micros
         FROM ledger WHERE org_id = ? AND type = 'funding' AND ref = ?`,
        [organizationId, fundingRef],
      );
      if (
        (priorLot.length !== 0 || priorFunding.length !== 0) &&
        (priorLot.length !== 1 ||
          priorLot[0]?.kind !== kind ||
          priorLot[0]?.consumption_class !== consumptionClass ||
          sqlMicros(priorLot[0]?.amount_micros) !== amountMicros ||
          (priorLot[0]?.expires_at ?? null) !== expiresAt ||
          priorFunding.length !== 1 ||
          sqlMicros(priorFunding[0]?.settled_delta_micros) !== amountMicros ||
          sqlMicros(priorFunding[0]?.held_delta_micros) !== 0)
      ) {
        throw new LedgerError("conservation_violated");
      }
      const createdAt = clock().toISOString();
      const refundsReady = await stripeRefundSchemaReady(sql);
      const guardId = `guard_${crypto.randomUUID()}`;
      const paidFreeGuard = hostedPaidFreeExclusion && consumptionClass === "free";
      const eligibilityGuardId = `${guardId}_free`;
      try {
        await sql.batch([
          ...(paidFreeGuard
            ? [
                {
                  sql: `INSERT INTO wallet_allocation_guards (id, valid)
                VALUES (?, CASE WHEN NOT ${hostedPaidFreeBlockedSql} THEN 1 ELSE 0 END)`,
                  params: [
                    eligibilityGuardId,
                    ...hostedPaidFreeBlockedParams(organizationId, createdAt),
                  ],
                },
              ]
            : []),
          {
            sql: `INSERT OR IGNORE INTO wallet_credit_lots
                  (org_id, ref, kind, consumption_class, amount_micros, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
            params: [
              organizationId,
              fundingRef,
              kind,
              consumptionClass,
              amountMicros,
              expiresAt,
              createdAt,
            ],
          },
          {
            sql: `INSERT OR IGNORE INTO ledger
                  (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at)
                VALUES (?, ?, 'funding', ?, ?, 0, ?)`,
            params: [
              `led_${crypto.randomUUID()}`,
              organizationId,
              fundingRef,
              amountMicros,
              createdAt,
            ],
          },
          {
            sql: `INSERT INTO wallet_allocation_guards (id, valid)
                SELECT ?, CASE WHEN
                  balance.settled BETWEEN 0 AND 9007199254740991
                  AND balance.held BETWEEN 0 AND 9007199254740991
                  AND balance.settled - balance.held BETWEEN 0 AND 9007199254740991
                  AND balance.allocated_held = balance.held
                  AND EXISTS (SELECT 1 FROM wallet_credit_lots l
                    WHERE l.org_id = ? AND l.ref = ? AND l.kind = ?
                      AND l.consumption_class = ? AND l.amount_micros = ?
                      AND l.expires_at IS ?)
                  AND EXISTS (SELECT 1 FROM ledger f
                    WHERE f.org_id = ? AND f.type = 'funding' AND f.ref = ?
                      AND f.settled_delta_micros = ? AND f.held_delta_micros = 0)
                  THEN 1 ELSE 0 END
                FROM (
                  SELECT
                    COALESCE((SELECT SUM(CASE
                      WHEN (l.expires_at IS NULL OR l.expires_at > ?)
                        ${hostedPaidFreeExclusion ? `AND NOT (l.consumption_class = 'free' AND ${hostedPaidFreeBlockedSql})` : ""} THEN
                        l.amount_micros - COALESCE((
                          SELECT SUM(a.amount_micros) FROM wallet_credit_allocations a
                          WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
                            AND a.debit_type IN ('capture', 'usage_debit')
                        ), 0) - ${
                          refundsReady
                            ? `COALESCE((SELECT SUM(r.debit_micros)
                          FROM stripe_billing_refunds r WHERE r.org_id = l.org_id
                            AND r.funding_ref = l.ref), 0)`
                            : "0"
                        }
                      ELSE COALESCE((
                        SELECT SUM(a.amount_micros) FROM wallet_credit_allocations a
                        WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
                          AND a.debit_type = 'hold'
                      ), 0)
                    END) FROM wallet_credit_lots l WHERE l.org_id = ?), 0) AS settled,
                    COALESCE((SELECT SUM(held_delta_micros) FROM ledger WHERE org_id = ?), 0) AS held,
                    COALESCE((SELECT SUM(amount_micros) FROM wallet_credit_allocations
                              WHERE org_id = ? AND debit_type = 'hold'), 0) AS allocated_held
                ) AS balance`,
            params: [
              guardId,
              organizationId,
              fundingRef,
              kind,
              consumptionClass,
              amountMicros,
              expiresAt,
              organizationId,
              fundingRef,
              amountMicros,
              createdAt,
              ...(hostedPaidFreeExclusion
                ? hostedPaidFreeBlockedParams(organizationId, createdAt)
                : []),
              organizationId,
              organizationId,
              organizationId,
            ],
          },
          { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [guardId] },
          ...(paidFreeGuard
            ? [
                {
                  sql: "DELETE FROM wallet_allocation_guards WHERE id = ?",
                  params: [eligibilityGuardId],
                },
              ]
            : []),
        ]);
      } catch (error) {
        if (!(paidFreeGuard && error instanceof SqlError && error.code === "constraint"))
          throw error;
        const blocked = await sql.query(
          `SELECT ${hostedPaidFreeBlockedSql} AS blocked`,
          hostedPaidFreeBlockedParams(organizationId, createdAt),
        );
        if (blocked.length !== 1 || Number(blocked[0]?.blocked) !== 1) throw error;
        const [lots, fundings] = await Promise.all([
          sql.query(
            "SELECT kind, consumption_class, amount_micros, expires_at FROM wallet_credit_lots WHERE org_id = ? AND ref = ?",
            [organizationId, fundingRef],
          ),
          sql.query(
            "SELECT settled_delta_micros, held_delta_micros FROM ledger WHERE org_id = ? AND type = 'funding' AND ref = ?",
            [organizationId, fundingRef],
          ),
        ]);
        if (
          (lots.length !== 0 || fundings.length !== 0) &&
          (lots.length !== 1 ||
            lots[0]?.kind !== kind ||
            lots[0]?.consumption_class !== consumptionClass ||
            sqlMicros(lots[0]?.amount_micros) !== amountMicros ||
            (lots[0]?.expires_at ?? null) !== expiresAt ||
            fundings.length !== 1 ||
            sqlMicros(fundings[0]?.settled_delta_micros) !== amountMicros ||
            sqlMicros(fundings[0]?.held_delta_micros) !== 0)
        )
          throw new LedgerError("conservation_violated");
        return this.wallet(organizationId);
      }
      const lot = await sql.query(
        `SELECT kind, consumption_class, amount_micros, expires_at FROM wallet_credit_lots
         WHERE org_id = ? AND ref = ?`,
        [organizationId, fundingRef],
      );
      if (
        lot.length !== 1 ||
        lot[0]?.kind !== kind ||
        lot[0]?.consumption_class !== consumptionClass ||
        sqlMicros(lot[0]?.amount_micros) !== amountMicros ||
        (lot[0]?.expires_at ?? null) !== expiresAt
      ) {
        throw new LedgerError("conservation_violated");
      }
      const funding = await sql.query(
        `SELECT settled_delta_micros, held_delta_micros FROM ledger
         WHERE org_id = ? AND type = 'funding' AND ref = ?`,
        [organizationId, fundingRef],
      );
      if (
        funding.length !== 1 ||
        sqlMicros(funding[0]?.settled_delta_micros) !== amountMicros ||
        sqlMicros(funding[0]?.held_delta_micros) !== 0
      ) {
        throw new LedgerError("conservation_violated");
      }
      return await this.wallet(organizationId);
    },

    async hasFunding({ organizationId, fundingRef }): Promise<boolean> {
      const rows = await sql.query(
        `SELECT 1 FROM ledger WHERE org_id = ? AND type = 'funding' AND ref = ?`,
        [organizationId, fundingRef],
      );
      return rows.length === 1;
    },

    async fundedReferences(entries): Promise<ReadonlySet<string>> {
      if (entries.length === 0) return new Set();
      // One bound parameter however long the batch: D1 caps parameters per
      // statement, and the join still uses the (org_id, type, ref) index.
      const rows = await sql.query(
        `SELECT ledger.ref AS ref
         FROM json_each(?) AS wanted
         JOIN ledger
           ON ledger.org_id = json_extract(wanted.value, '$[0]')
          AND ledger.type = 'funding'
          AND ledger.ref = json_extract(wanted.value, '$[1]')`,
        [JSON.stringify(entries.map((entry) => [entry.organizationId, entry.fundingRef]))],
      );
      return new Set(rows.map((row) => String(row.ref)));
    },

    async hold({ organizationId, reference, amountMicros }): Promise<boolean> {
      positiveAmount(amountMicros);
      const existing = await sql.query(
        `SELECT held_delta_micros FROM ledger
         WHERE org_id = ? AND type = 'hold' AND ref = ?`,
        [organizationId, reference],
      );
      if (existing.length === 1) {
        if (sqlMicros(existing[0]?.held_delta_micros) !== amountMicros) {
          throw new LedgerError("conservation_violated");
        }
        return true;
      }
      const now = clock().toISOString();
      try {
        await allocateAndRecord(
          organizationId,
          "hold",
          reference,
          amountMicros,
          0,
          amountMicros,
          now,
        );
        return true;
      } catch (error) {
        if (error instanceof LedgerError && error.code === "insufficient_funds") return false;
        const replay = await sql.query(
          `SELECT held_delta_micros FROM ledger
           WHERE org_id = ? AND type = 'hold' AND ref = ?`,
          [organizationId, reference],
        );
        if (replay.length === 1 && sqlMicros(replay[0]?.held_delta_micros) === amountMicros)
          return true;
        const available = await availableAt(organizationId, now);
        if (available < amountMicros) return false;
        throw error;
      }
    },

    async capture({ organizationId, reference, amountMicros }): Promise<void> {
      positiveAmount(amountMicros);
      const existing = await sql.query(
        `SELECT settled_delta_micros, held_delta_micros FROM ledger
         WHERE org_id = ? AND type = 'capture' AND ref = ?`,
        [organizationId, reference],
      );
      if (existing.length === 1) {
        if (
          sqlMicros(existing[0]?.settled_delta_micros) !== -amountMicros ||
          sqlMicros(existing[0]?.held_delta_micros) !== -amountMicros
        ) {
          throw new LedgerError("conservation_violated");
        }
        return;
      }
      await settleHold(organizationId, "capture", reference, amountMicros);
    },

    async release({ organizationId, reference, amountMicros }): Promise<void> {
      positiveAmount(amountMicros);
      const existing = await sql.query(
        `SELECT settled_delta_micros, held_delta_micros FROM ledger
         WHERE org_id = ? AND type = 'release' AND ref = ?`,
        [organizationId, reference],
      );
      if (existing.length === 1) {
        if (
          sqlMicros(existing[0]?.settled_delta_micros) !== 0 ||
          sqlMicros(existing[0]?.held_delta_micros) !== -amountMicros
        ) {
          throw new LedgerError("conservation_violated");
        }
        return;
      }
      await settleHold(organizationId, "release", reference, amountMicros);
    },

    async debitUsage({ organizationId, reference, amountMicros }): Promise<boolean> {
      positiveAmount(amountMicros);
      const existing = await sql.query(
        `SELECT settled_delta_micros, held_delta_micros FROM ledger
         WHERE org_id = ? AND type = 'usage_debit' AND ref = ?`,
        [organizationId, reference],
      );
      if (existing.length === 1) {
        return (
          sqlMicros(existing[0]?.settled_delta_micros) === -amountMicros &&
          sqlMicros(existing[0]?.held_delta_micros) === 0
        );
      }
      try {
        await allocateAndRecord(
          organizationId,
          "usage_debit",
          reference,
          amountMicros,
          -amountMicros,
          0,
          clock().toISOString(),
        );
        return true;
      } catch (error) {
        if (error instanceof LedgerError && error.code === "insufficient_funds") return false;
        throw error;
      }
    },
  };

  async function allocateAndRecord(
    organizationId: string,
    type: "hold" | "usage_debit",
    reference: string,
    amountMicros: number,
    settledDeltaMicros: number,
    heldDeltaMicros: number,
    now: string,
  ): Promise<void> {
    await sql.batch(
      await prepareLedgerAllocation(sql, {
        organizationId,
        type,
        reference,
        amountMicros,
        settledDeltaMicros,
        heldDeltaMicros,
        now,
        hostedPaidFreeExclusion,
      }),
    );
  }

  async function settleHold(
    organizationId: string,
    type: "capture" | "release",
    reference: string,
    amountMicros: number,
  ): Promise<void> {
    await sql.batch(
      await planHoldSettlement(sql, clock, organizationId, type, reference, amountMicros),
    );
  }

  async function availableAt(organizationId: string, now: string): Promise<number> {
    const refundsReady = await stripeRefundSchemaReady(sql);
    const rows = await sql.query(
      `SELECT COALESCE(SUM(l.amount_micros - COALESCE((
         SELECT SUM(a.amount_micros) FROM wallet_credit_allocations a
         WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
       ), 0) - ${
         refundsReady
           ? `COALESCE((SELECT SUM(r.debit_micros)
         FROM stripe_billing_refunds r WHERE r.org_id = l.org_id AND r.funding_ref = l.ref), 0)`
           : "0"
}), 0) AS available
       FROM wallet_credit_lots l
       WHERE l.org_id = ? AND (l.expires_at IS NULL OR l.expires_at > ?)
       ${hostedPaidFreeExclusion ? `AND NOT (l.consumption_class = 'free' AND ${hostedPaidFreeBlockedSql})` : ""}
       ${
         refundsReady
           ? `AND NOT EXISTS (SELECT 1 FROM stripe_billing_fences f
          WHERE f.org_id = l.org_id AND f.funding_ref = l.ref AND f.active = 1)`
           : ""
}`,
      [
        organizationId,
        now,
        ...(hostedPaidFreeExclusion ? hostedPaidFreeBlockedParams(organizationId, now) : []),
      ],
    );
    return sqlMicros(rows[0]?.available ?? 0);
  }
}

async function planHoldSettlement(
  sql: Sql,
  clock: Clock,
  organizationId: string,
  type: "capture" | "release",
  reference: string,
  amountMicros: number,
): Promise<readonly SqlStatement[]> {
  const refundsReady = await stripeRefundSchemaReady(sql);
  const now = clock().toISOString();
  const balanceRows = await sql.query(
    `SELECT COALESCE(SUM(held_delta_micros), 0) AS remaining
     FROM ledger WHERE org_id = ? AND ref = ?`,
    [organizationId, reference],
  );
  const heldRows = await sql.query(
    `SELECT a.lot_ref, a.amount_micros
       FROM wallet_credit_allocations a
       JOIN wallet_credit_lots l ON l.org_id = a.org_id AND l.ref = a.lot_ref
       WHERE a.org_id = ? AND a.debit_type = 'hold' AND a.debit_ref = ?
       ORDER BY CASE l.consumption_class WHEN 'free' THEN 0 WHEN 'subscription' THEN 1 ELSE 2 END,
                CASE WHEN l.expires_at IS NULL THEN 1 ELSE 0 END,
                l.expires_at, l.created_at, l.ref`,
    [organizationId, reference],
  );
  const captureRows = await sql.query(
    `SELECT COALESCE(SUM(amount_micros), 0) AS captured
       FROM wallet_credit_allocations
       WHERE org_id = ? AND debit_type = 'capture' AND debit_ref = ?`,
    [organizationId, reference],
  );
  const remainingHold = sqlMicros(balanceRows[0]?.remaining ?? 0);
  const allocatedHold = sqlMicros(
    heldRows.reduce((sum, row) => sum + BigInt(sqlMicros(row.amount_micros)), 0n),
  );
  const capturedBefore = sqlMicros(captureRows[0]?.captured ?? 0);
  if (remainingHold < amountMicros) throw new LedgerError("conservation_violated");
  if (
    refundsReady &&
    type === "capture" &&
    (
      await sql.query(
        `SELECT 1 FROM wallet_credit_allocations a JOIN stripe_billing_fences f
       ON f.org_id = a.org_id AND f.funding_ref = a.lot_ref AND f.active = 1
       WHERE a.org_id = ? AND a.debit_type = 'hold' AND a.debit_ref = ? LIMIT 1`,
        [organizationId, reference],
      )
    ).length
  )
    throw new LedgerError("conservation_violated");
  if (allocatedHold !== remainingHold) throw new LedgerError("conservation_violated");
  if (type === "release" && remainingHold !== amountMicros) {
    throw new LedgerError("conservation_violated");
  }

  let remaining = amountMicros;
  const selected: Array<{
    readonly lotRef: string;
    readonly amount: number;
    readonly previous: number;
  }> = [];
  for (const row of heldRows) {
    const previous = sqlMicros(row.amount_micros);
    const amount = Math.min(remaining, previous);
    if (amount > 0) selected.push({ lotRef: String(row.lot_ref), amount, previous });
    remaining -= amount;
    if (remaining === 0) break;
  }
  if (remaining !== 0) throw new LedgerError("conservation_violated");

  const guardId = `guard_${crypto.randomUUID()}`;
  const moveStatements: SqlStatement[] = selected.flatMap((allocation) => {
    const shrink: SqlStatement =
      allocation.amount === allocation.previous
        ? {
            sql: `DELETE FROM wallet_credit_allocations
                    WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ? AND lot_ref = ?
                      AND amount_micros = ?`,
            params: [organizationId, reference, allocation.lotRef, allocation.previous],
          }
        : {
            sql: `UPDATE wallet_credit_allocations SET amount_micros = ?
                    WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ? AND lot_ref = ?
                      AND amount_micros = ?`,
            params: [
              allocation.previous - allocation.amount,
              organizationId,
              reference,
              allocation.lotRef,
              allocation.previous,
            ],
          };
    if (type === "release") return [shrink];
    return [
      shrink,
      {
        sql: `INSERT INTO wallet_credit_allocations
                  (org_id, debit_type, debit_ref, lot_ref, amount_micros, created_at)
                VALUES (?, 'capture', ?, ?, ?, ?)`,
        params: [organizationId, reference, allocation.lotRef, allocation.amount, now],
      },
    ];
  });
  return [
    ...(refundsReady && type === "capture"
      ? [
          {
            sql: `INSERT INTO wallet_allocation_guards (id, valid) VALUES (?, CASE WHEN
        NOT EXISTS (SELECT 1 FROM wallet_credit_allocations a JOIN stripe_billing_fences f
          ON f.org_id = a.org_id AND f.funding_ref = a.lot_ref AND f.active = 1
          WHERE a.org_id = ? AND a.debit_type = 'hold' AND a.debit_ref = ?)
        THEN 1 ELSE 0 END)`,
            params: [`${guardId}_freeze`, organizationId, reference],
          },
        ]
      : []),
    ...moveStatements,
    {
      sql: `INSERT INTO wallet_allocation_guards (id, valid)
              VALUES (?, CASE WHEN
                (SELECT COALESCE(SUM(amount_micros), 0)
                 FROM wallet_credit_allocations
                 WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?) = ?
                AND (SELECT COALESCE(SUM(amount_micros), 0)
                     FROM wallet_credit_allocations
                     WHERE org_id = ? AND debit_type = 'capture' AND debit_ref = ?) = ?
                THEN 1 ELSE 0 END)`,
      params: [
        guardId,
        organizationId,
        reference,
        remainingHold - amountMicros,
        organizationId,
        reference,
        capturedBefore + (type === "capture" ? amountMicros : 0),
      ],
    },
    {
      sql: `INSERT INTO ledger
                (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        `led_${crypto.randomUUID()}`,
        organizationId,
        type,
        reference,
        type === "capture" ? -amountMicros : 0,
        -amountMicros,
        now,
      ],
    },
    {
      sql: "DELETE FROM wallet_allocation_guards WHERE id IN (?, ?)",
      params: [guardId, `${guardId}_freeze`],
    },
  ];
}

function positiveAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new LedgerError("invalid_amount");
  return value;
}

function quoteMicros(amountMinor: number): number {
  try {
    return minorToMicros(amountMinor);
  } catch {
    throw new LedgerError("invalid_amount");
  }
}

function sqlMicros(value: unknown): number {
  if (
    (typeof value !== "number" && typeof value !== "bigint") ||
    (typeof value === "number" && !Number.isSafeInteger(value)) ||
    BigInt(value) < -BigInt(Number.MAX_SAFE_INTEGER) ||
    BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new LedgerError("conservation_violated");
  }
  return Number(value);
}

/** Plans a lot allocation for an enclosing durable lifecycle batch. */
export async function prepareLedgerAllocation(
  sql: Sql,
  input: {
    readonly organizationId: string;
    readonly type: "hold" | "usage_debit";
    readonly reference: string;
    readonly amountMicros: number;
    readonly settledDeltaMicros: number;
    readonly heldDeltaMicros: number;
    readonly now: string;
    readonly hostedPaidFreeExclusion?: boolean;
  },
): Promise<readonly SqlStatement[]> {
  const refundsReady = await stripeRefundSchemaReady(sql);
  const {
    organizationId,
    type,
    reference,
    amountMicros,
    settledDeltaMicros,
    heldDeltaMicros,
    now,
    hostedPaidFreeExclusion = false,
  } = input;
  positiveAmount(amountMicros);
  if (
    !Number.isSafeInteger(settledDeltaMicros) ||
    !Number.isSafeInteger(heldDeltaMicros) ||
    (type === "hold" && (settledDeltaMicros !== 0 || heldDeltaMicros !== amountMicros)) ||
    (type === "usage_debit" && (settledDeltaMicros !== -amountMicros || heldDeltaMicros !== 0))
  ) {
    throw new LedgerError("invalid_amount");
  }
  if (
    refundsReady &&
    (
      await sql.query(
        "SELECT 1 FROM stripe_billing_refunds WHERE org_id = ? AND receivable_micros > 0 LIMIT 1",
        [organizationId],
      )
    ).length
  )
    throw new LedgerError("insufficient_funds");
  const lots = await sql.query(
    `SELECT l.ref,
              l.amount_micros - COALESCE(SUM(a.amount_micros), 0)
                - ${
                  refundsReady
                    ? `COALESCE((SELECT SUM(r.debit_micros)
                    FROM stripe_billing_refunds r WHERE r.org_id = l.org_id
                      AND r.funding_ref = l.ref), 0)`
                    : "0"
                } AS remaining
       FROM wallet_credit_lots l
       LEFT JOIN wallet_credit_allocations a
         ON a.org_id = l.org_id AND a.lot_ref = l.ref
       WHERE l.org_id = ? AND (l.expires_at IS NULL OR l.expires_at > ?)
         ${hostedPaidFreeExclusion ? `AND NOT (l.consumption_class = 'free' AND ${hostedPaidFreeBlockedSql})` : ""}
         ${
           refundsReady
             ? `AND NOT EXISTS (SELECT 1 FROM stripe_billing_fences f
           WHERE f.org_id = l.org_id AND f.funding_ref = l.ref AND f.active = 1)`
             : ""
}
       GROUP BY l.org_id, l.ref, l.amount_micros, l.expires_at, l.created_at
       HAVING remaining > 0
       ORDER BY CASE l.consumption_class WHEN 'free' THEN 0 WHEN 'subscription' THEN 1 ELSE 2 END,
                CASE WHEN l.expires_at IS NULL THEN 1 ELSE 0 END,
                l.expires_at, l.created_at, l.ref`,
    [
      organizationId,
      now,
      ...(hostedPaidFreeExclusion ? hostedPaidFreeBlockedParams(organizationId, now) : []),
    ],
  );
  let remaining = amountMicros;
  const allocations: Array<{ readonly lotRef: string; readonly amount: number }> = [];
  for (const lot of lots) {
    const amount = Math.min(remaining, sqlMicros(lot.remaining));
    if (amount > 0) allocations.push({ lotRef: String(lot.ref), amount });
    remaining -= amount;
    if (remaining === 0) break;
  }
  if (remaining !== 0) throw new LedgerError("insufficient_funds");
  const guardId = `guard_${crypto.randomUUID()}`;
  const debtGuardId = `${guardId}_receivable`;
  const statements = allocations.map((allocation) => ({
    sql: `INSERT OR IGNORE INTO wallet_credit_allocations
              (org_id, debit_type, debit_ref, lot_ref, amount_micros, created_at)
            SELECT ?, ?, ?, ?, ?, ?
            WHERE (
              SELECT amount_micros - COALESCE((
                SELECT SUM(amount_micros) FROM wallet_credit_allocations
                WHERE org_id = ? AND lot_ref = ?
              ), 0) - ${
                refundsReady
                  ? `COALESCE((SELECT SUM(debit_micros)
                   FROM stripe_billing_refunds WHERE org_id = ? AND funding_ref = ?), 0)`
                  : "0"
              }
              FROM wallet_credit_lots WHERE org_id = ? AND ref = ?
                ${hostedPaidFreeExclusion ? `AND NOT (consumption_class = 'free' AND ${hostedPaidFreeBlockedSql})` : ""}
                ${
                  refundsReady
                    ? `AND NOT EXISTS (SELECT 1 FROM stripe_billing_fences
                  WHERE org_id = ? AND funding_ref = ? AND active = 1)`
                    : ""
                }
            ) >= ?`,
    params: [
      organizationId,
      type,
      reference,
      allocation.lotRef,
      allocation.amount,
      now,
      organizationId,
      allocation.lotRef,
      ...(refundsReady ? [organizationId, allocation.lotRef] : []),
      organizationId,
      allocation.lotRef,
      ...(hostedPaidFreeExclusion ? hostedPaidFreeBlockedParams(organizationId, now) : []),
      ...(refundsReady ? [organizationId, allocation.lotRef] : []),
      allocation.amount,
    ],
  }));
  return [
    ...(refundsReady
      ? [
          {
            sql: `INSERT INTO wallet_allocation_guards (id, valid) VALUES (?, CASE WHEN
              NOT EXISTS (SELECT 1 FROM stripe_billing_refunds
                WHERE org_id = ? AND receivable_micros > 0)
              THEN 1 ELSE 0 END)`,
            params: [debtGuardId, organizationId],
          },
        ]
      : []),
    ...statements,
    {
      sql: `INSERT INTO wallet_allocation_guards (id, valid)
              VALUES (?, CASE WHEN (
                SELECT COALESCE(SUM(amount_micros), 0)
                FROM wallet_credit_allocations
                WHERE org_id = ? AND debit_type = ? AND debit_ref = ?
              ) = ? THEN 1 ELSE 0 END)`,
      params: [guardId, organizationId, type, reference, amountMicros],
    },
    {
      sql: `INSERT OR IGNORE INTO ledger
                (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        `led_${crypto.randomUUID()}`,
        organizationId,
        type,
        reference,
        settledDeltaMicros,
        heldDeltaMicros,
        now,
      ],
    },
    {
      sql: "DELETE FROM wallet_allocation_guards WHERE id IN (?, ?)",
      params: [guardId, debtGuardId],
    },
  ];
}
