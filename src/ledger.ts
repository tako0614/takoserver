import type { Clock, Sql } from "./ports.ts";

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

export type LedgerEntryType = "funding" | "hold" | "capture" | "release" | "usage_debit";

export interface LedgerEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly type: LedgerEntryType;
  readonly reference: string;
  readonly settledDeltaMinor: number;
  readonly heldDeltaMinor: number;
  readonly createdAt: string;
}

export interface Wallet {
  readonly organizationId: string;
  readonly currency: "USD";
  readonly settledMinor: number;
  readonly heldMinor: number;
  readonly availableMinor: number;
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

export interface Ledger {
  wallet(organizationId: string): Promise<Wallet>;
  /** Credits settled funds. Repeating a funding reference credits once. */
  fund(input: {
    readonly organizationId: string;
    readonly fundingRef: string;
    readonly amountMinor: number;
    readonly kind?: "direct" | "plan-included" | "purchased";
    readonly expiresAt?: string | null;
  }): Promise<Wallet>;
  /**
   * Earmarks funds. Returns false when the balance cannot cover the amount —
   * the decision is made by the insert itself, so two concurrent holds can
   * never both succeed against the same funds.
   */
  hold(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly amountMinor: number;
  }): Promise<boolean>;
  capture(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly amountMinor: number;
  }): Promise<void>;
  release(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly amountMinor: number;
  }): Promise<void>;
  /**
   * Charges metered usage directly against available prepaid funds. Returns
   * false without writing when the Wallet cannot cover the charge; replaying
   * the same exact reference and amount returns true.
   */
  debitUsage(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly amountMinor: number;
  }): Promise<boolean>;
}

export function createLedger(sql: Sql, clock: Clock): Ledger {
  return {
    async wallet(organizationId): Promise<Wallet> {
      const totals = await sql.query(
        `SELECT
           COALESCE((
             SELECT SUM(CASE
               WHEN l.expires_at IS NULL OR l.expires_at > ? THEN
                 l.amount_minor - COALESCE((
                   SELECT SUM(a.amount_minor)
                   FROM wallet_credit_allocations a
                   WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
                     AND a.debit_type IN ('capture', 'usage_debit')
                 ), 0)
               ELSE COALESCE((
                 SELECT SUM(a.amount_minor)
                 FROM wallet_credit_allocations a
                 WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
                   AND a.debit_type = 'hold'
               ), 0)
             END)
             FROM wallet_credit_lots l
             WHERE l.org_id = ?
           ), 0) AS settled,
           COALESCE((
             SELECT SUM(held_delta) FROM ledger WHERE org_id = ?
           ), 0) AS held,
           COALESCE((
             SELECT SUM(amount_minor) FROM wallet_credit_allocations
             WHERE org_id = ? AND debit_type = 'hold'
           ), 0) AS allocated_held`,
        [clock().toISOString(), organizationId, organizationId, organizationId],
      );
      const settledMinor = Number(totals[0]?.settled ?? 0);
      const heldMinor = Number(totals[0]?.held ?? 0);
      const allocatedHeldMinor = Number(totals[0]?.allocated_held ?? 0);
      const availableMinor = settledMinor - heldMinor;
      // Any of these going negative means entries were written that the rules
      // above forbid. Reporting a wrong balance would be worse than failing.
      if (
        settledMinor < 0 ||
        heldMinor < 0 ||
        availableMinor < 0 ||
        allocatedHeldMinor !== heldMinor
      ) {
        throw new LedgerError("conservation_violated");
      }
      const rows = await sql.query(
        `SELECT id, type, ref, settled_delta, held_delta, created_at
         FROM ledger WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        [organizationId, WALLET_ENTRY_PAGE],
      );
      return {
        organizationId,
        currency: "USD",
        settledMinor,
        heldMinor,
        availableMinor,
        entries: rows.map((row) => ({
          id: String(row.id),
          organizationId,
          type: String(row.type) as LedgerEntryType,
          reference: String(row.ref),
          settledDeltaMinor: Number(row.settled_delta),
          heldDeltaMinor: Number(row.held_delta),
          createdAt: String(row.created_at),
        })),
      };
    },

    async fund({
      organizationId,
      fundingRef,
      amountMinor,
      kind = "direct",
      expiresAt = null,
    }): Promise<Wallet> {
      positiveAmount(amountMinor);
      if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) {
        throw new LedgerError("invalid_amount");
      }
      const createdAt = clock().toISOString();
      await sql.batch([
        {
          sql: `INSERT OR IGNORE INTO wallet_credit_lots
                  (org_id, ref, kind, amount_minor, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          params: [organizationId, fundingRef, kind, amountMinor, expiresAt, createdAt],
        },
        {
          sql: `INSERT OR IGNORE INTO ledger
                  (id, org_id, type, ref, settled_delta, held_delta, created_at)
                VALUES (?, ?, 'funding', ?, ?, 0, ?)`,
          params: [
            `led_${crypto.randomUUID()}`,
            organizationId,
            fundingRef,
            amountMinor,
            createdAt,
          ],
        },
      ]);
      const lot = await sql.query(
        `SELECT kind, amount_minor, expires_at FROM wallet_credit_lots
         WHERE org_id = ? AND ref = ?`,
        [organizationId, fundingRef],
      );
      if (
        lot.length !== 1 ||
        lot[0]?.kind !== kind ||
        Number(lot[0]?.amount_minor) !== amountMinor ||
        (lot[0]?.expires_at ?? null) !== expiresAt
      ) {
        throw new LedgerError("conservation_violated");
      }
      return await this.wallet(organizationId);
    },

    async hold({ organizationId, reference, amountMinor }): Promise<boolean> {
      positiveAmount(amountMinor);
      const existing = await sql.query(
        `SELECT held_delta FROM ledger
         WHERE org_id = ? AND type = 'hold' AND ref = ?`,
        [organizationId, reference],
      );
      if (existing.length === 1) {
        if (Number(existing[0]?.held_delta) !== amountMinor) {
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
          amountMinor,
          0,
          amountMinor,
          now,
        );
        return true;
      } catch (error) {
        if (error instanceof LedgerError && error.code === "insufficient_funds") return false;
        const replay = await sql.query(
          `SELECT held_delta FROM ledger
           WHERE org_id = ? AND type = 'hold' AND ref = ?`,
          [organizationId, reference],
        );
        if (replay.length === 1 && Number(replay[0]?.held_delta) === amountMinor) return true;
        const available = await availableAt(organizationId, now);
        if (available < amountMinor) return false;
        throw error;
      }
    },

    async capture({ organizationId, reference, amountMinor }): Promise<void> {
      positiveAmount(amountMinor);
      const existing = await sql.query(
        `SELECT settled_delta, held_delta FROM ledger
         WHERE org_id = ? AND type = 'capture' AND ref = ?`,
        [organizationId, reference],
      );
      if (existing.length === 1) {
        if (
          Number(existing[0]?.settled_delta) !== -amountMinor ||
          Number(existing[0]?.held_delta) !== -amountMinor
        ) {
          throw new LedgerError("conservation_violated");
        }
        return;
      }
      await settleHold(organizationId, "capture", reference, amountMinor);
    },

    async release({ organizationId, reference, amountMinor }): Promise<void> {
      positiveAmount(amountMinor);
      const existing = await sql.query(
        `SELECT settled_delta, held_delta FROM ledger
         WHERE org_id = ? AND type = 'release' AND ref = ?`,
        [organizationId, reference],
      );
      if (existing.length === 1) {
        if (
          Number(existing[0]?.settled_delta) !== 0 ||
          Number(existing[0]?.held_delta) !== -amountMinor
        ) {
          throw new LedgerError("conservation_violated");
        }
        return;
      }
      await settleHold(organizationId, "release", reference, amountMinor);
    },

    async debitUsage({ organizationId, reference, amountMinor }): Promise<boolean> {
      positiveAmount(amountMinor);
      const existing = await sql.query(
        `SELECT settled_delta, held_delta FROM ledger
         WHERE org_id = ? AND type = 'usage_debit' AND ref = ?`,
        [organizationId, reference],
      );
      if (existing.length === 1) {
        return (
          Number(existing[0]?.settled_delta) === -amountMinor &&
          Number(existing[0]?.held_delta) === 0
        );
      }
      try {
        await allocateAndRecord(
          organizationId,
          "usage_debit",
          reference,
          amountMinor,
          -amountMinor,
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
    amountMinor: number,
    settledDeltaMinor: number,
    heldDeltaMinor: number,
    now: string,
  ): Promise<void> {
    const lots = await sql.query(
      `SELECT l.ref,
              l.amount_minor - COALESCE(SUM(a.amount_minor), 0) AS remaining
       FROM wallet_credit_lots l
       LEFT JOIN wallet_credit_allocations a
         ON a.org_id = l.org_id AND a.lot_ref = l.ref
       WHERE l.org_id = ? AND (l.expires_at IS NULL OR l.expires_at > ?)
       GROUP BY l.org_id, l.ref, l.amount_minor, l.expires_at, l.created_at
       HAVING remaining > 0
       ORDER BY CASE WHEN l.expires_at IS NULL THEN 1 ELSE 0 END,
                l.expires_at, l.created_at, l.ref`,
      [organizationId, now],
    );
    let remaining = amountMinor;
    const allocations: Array<{ readonly lotRef: string; readonly amount: number }> = [];
    for (const lot of lots) {
      const amount = Math.min(remaining, Number(lot.remaining));
      if (amount > 0) allocations.push({ lotRef: String(lot.ref), amount });
      remaining -= amount;
      if (remaining === 0) break;
    }
    if (remaining !== 0) throw new LedgerError("insufficient_funds");
    const guardId = `guard_${crypto.randomUUID()}`;
    const statements = allocations.map((allocation) => ({
      sql: `INSERT OR IGNORE INTO wallet_credit_allocations
              (org_id, debit_type, debit_ref, lot_ref, amount_minor, created_at)
            SELECT ?, ?, ?, ?, ?, ?
            WHERE (
              SELECT amount_minor - COALESCE((
                SELECT SUM(amount_minor) FROM wallet_credit_allocations
                WHERE org_id = ? AND lot_ref = ?
              ), 0)
              FROM wallet_credit_lots WHERE org_id = ? AND ref = ?
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
        organizationId,
        allocation.lotRef,
        allocation.amount,
      ],
    }));
    await sql.batch([
      ...statements,
      {
        sql: `INSERT INTO wallet_allocation_guards (id, valid)
              VALUES (?, CASE WHEN (
                SELECT COALESCE(SUM(amount_minor), 0)
                FROM wallet_credit_allocations
                WHERE org_id = ? AND debit_type = ? AND debit_ref = ?
              ) = ? THEN 1 ELSE 0 END)`,
        params: [guardId, organizationId, type, reference, amountMinor],
      },
      {
        sql: `INSERT OR IGNORE INTO ledger
                (id, org_id, type, ref, settled_delta, held_delta, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          `led_${crypto.randomUUID()}`,
          organizationId,
          type,
          reference,
          settledDeltaMinor,
          heldDeltaMinor,
          now,
        ],
      },
      { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [guardId] },
    ]);
  }

  async function settleHold(
    organizationId: string,
    type: "capture" | "release",
    reference: string,
    amountMinor: number,
  ): Promise<void> {
    const now = clock().toISOString();
    const balanceRows = await sql.query(
      `SELECT COALESCE(SUM(held_delta), 0) AS remaining
       FROM ledger WHERE org_id = ? AND ref = ?`,
      [organizationId, reference],
    );
    const heldRows = await sql.query(
      `SELECT a.lot_ref, a.amount_minor
       FROM wallet_credit_allocations a
       JOIN wallet_credit_lots l ON l.org_id = a.org_id AND l.ref = a.lot_ref
       WHERE a.org_id = ? AND a.debit_type = 'hold' AND a.debit_ref = ?
       ORDER BY CASE WHEN l.expires_at IS NULL THEN 1 ELSE 0 END,
                l.expires_at, l.created_at, l.ref`,
      [organizationId, reference],
    );
    const captureRows = await sql.query(
      `SELECT COALESCE(SUM(amount_minor), 0) AS captured
       FROM wallet_credit_allocations
       WHERE org_id = ? AND debit_type = 'capture' AND debit_ref = ?`,
      [organizationId, reference],
    );
    const remainingHold = Number(balanceRows[0]?.remaining ?? 0);
    const allocatedHold = heldRows.reduce((sum, row) => sum + Number(row.amount_minor), 0);
    const capturedBefore = Number(captureRows[0]?.captured ?? 0);
    if (remainingHold < amountMinor) throw new LedgerError("conservation_violated");
    if (allocatedHold !== remainingHold) throw new LedgerError("conservation_violated");
    if (type === "release" && remainingHold !== amountMinor) {
      throw new LedgerError("conservation_violated");
    }

    let remaining = amountMinor;
    const selected: Array<{
      readonly lotRef: string;
      readonly amount: number;
      readonly previous: number;
    }> = [];
    for (const row of heldRows) {
      const previous = Number(row.amount_minor);
      const amount = Math.min(remaining, previous);
      if (amount > 0) selected.push({ lotRef: String(row.lot_ref), amount, previous });
      remaining -= amount;
      if (remaining === 0) break;
    }
    if (remaining !== 0) throw new LedgerError("conservation_violated");

    const guardId = `guard_${crypto.randomUUID()}`;
    const moveStatements = selected.flatMap((allocation) => {
      const shrink =
        allocation.amount === allocation.previous
          ? {
              sql: `DELETE FROM wallet_credit_allocations
                    WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ? AND lot_ref = ?
                      AND amount_minor = ?`,
              params: [organizationId, reference, allocation.lotRef, allocation.previous],
            }
          : {
              sql: `UPDATE wallet_credit_allocations SET amount_minor = ?
                    WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ? AND lot_ref = ?
                      AND amount_minor = ?`,
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
                  (org_id, debit_type, debit_ref, lot_ref, amount_minor, created_at)
                VALUES (?, 'capture', ?, ?, ?, ?)`,
          params: [organizationId, reference, allocation.lotRef, allocation.amount, now],
        },
      ];
    });
    await sql.batch([
      ...moveStatements,
      {
        sql: `INSERT INTO wallet_allocation_guards (id, valid)
              VALUES (?, CASE WHEN
                (SELECT COALESCE(SUM(amount_minor), 0)
                 FROM wallet_credit_allocations
                 WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?) = ?
                AND (SELECT COALESCE(SUM(amount_minor), 0)
                     FROM wallet_credit_allocations
                     WHERE org_id = ? AND debit_type = 'capture' AND debit_ref = ?) = ?
                THEN 1 ELSE 0 END)`,
        params: [
          guardId,
          organizationId,
          reference,
          remainingHold - amountMinor,
          organizationId,
          reference,
          capturedBefore + (type === "capture" ? amountMinor : 0),
        ],
      },
      {
        sql: `INSERT INTO ledger
                (id, org_id, type, ref, settled_delta, held_delta, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          `led_${crypto.randomUUID()}`,
          organizationId,
          type,
          reference,
          type === "capture" ? -amountMinor : 0,
          -amountMinor,
          now,
        ],
      },
      { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [guardId] },
    ]);
  }

  async function availableAt(organizationId: string, now: string): Promise<number> {
    const rows = await sql.query(
      `SELECT COALESCE(SUM(l.amount_minor - COALESCE((
         SELECT SUM(a.amount_minor) FROM wallet_credit_allocations a
         WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
       ), 0)), 0) AS available
       FROM wallet_credit_lots l
       WHERE l.org_id = ? AND (l.expires_at IS NULL OR l.expires_at > ?)`,
      [organizationId, now],
    );
    return Number(rows[0]?.available ?? 0);
  }
}

function positiveAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new LedgerError("invalid_amount");
  return value;
}
