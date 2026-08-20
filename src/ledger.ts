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
  const append = async (
    organizationId: string,
    type: LedgerEntryType,
    reference: string,
    settledDelta: number,
    heldDelta: number,
  ): Promise<number> => {
    const written = await sql.run(
      `INSERT OR IGNORE INTO ledger
         (id, org_id, type, ref, settled_delta, held_delta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        `led_${crypto.randomUUID()}`,
        organizationId,
        type,
        reference,
        settledDelta,
        heldDelta,
        clock().toISOString(),
      ],
    );
    return written.changes;
  };

  return {
    async wallet(organizationId): Promise<Wallet> {
      const totals = await sql.query(
        `SELECT COALESCE(SUM(settled_delta), 0) AS settled,
                COALESCE(SUM(held_delta), 0) AS held
         FROM ledger WHERE org_id = ?`,
        [organizationId],
      );
      const settledMinor = Number(totals[0]?.settled ?? 0);
      const heldMinor = Number(totals[0]?.held ?? 0);
      const availableMinor = settledMinor - heldMinor;
      // Any of these going negative means entries were written that the rules
      // above forbid. Reporting a wrong balance would be worse than failing.
      if (settledMinor < 0 || heldMinor < 0 || availableMinor < 0) {
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

    async fund({ organizationId, fundingRef, amountMinor }): Promise<Wallet> {
      positiveAmount(amountMinor);
      await append(organizationId, "funding", fundingRef, amountMinor, 0);
      return await this.wallet(organizationId);
    },

    async hold({ organizationId, reference, amountMinor }): Promise<boolean> {
      positiveAmount(amountMinor);
      const written = await sql.run(
        `INSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta, created_at)
         SELECT ?, ?, 'hold', ?, 0, ?, ?
         WHERE NOT EXISTS (
                 SELECT 1 FROM ledger WHERE org_id = ? AND type = 'hold' AND ref = ?
               )
           AND (SELECT COALESCE(SUM(settled_delta - held_delta), 0)
                FROM ledger WHERE org_id = ?) >= ?`,
        [
          `led_${crypto.randomUUID()}`,
          organizationId,
          reference,
          amountMinor,
          clock().toISOString(),
          organizationId,
          reference,
          organizationId,
          amountMinor,
        ],
      );
      if (written.changes === 1) return true;
      // Zero rows means either the balance was short or this hold already
      // exists; an existing hold is a replay and must read as success.
      const existing = await sql.query(
        "SELECT 1 AS present FROM ledger WHERE org_id = ? AND type = 'hold' AND ref = ?",
        [organizationId, reference],
      );
      return existing.length === 1;
    },

    async capture({ organizationId, reference, amountMinor }): Promise<void> {
      positiveAmount(amountMinor);
      await append(organizationId, "capture", reference, -amountMinor, -amountMinor);
    },

    async release({ organizationId, reference, amountMinor }): Promise<void> {
      positiveAmount(amountMinor);
      await append(organizationId, "release", reference, 0, -amountMinor);
    },

    async debitUsage({ organizationId, reference, amountMinor }): Promise<boolean> {
      positiveAmount(amountMinor);
      const written = await sql.run(
        `INSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta, created_at)
         SELECT ?, ?, 'usage_debit', ?, ?, 0, ?
         WHERE NOT EXISTS (
                 SELECT 1 FROM ledger
                 WHERE org_id = ? AND type = 'usage_debit' AND ref = ?
               )
           AND (SELECT COALESCE(SUM(settled_delta - held_delta), 0)
                FROM ledger WHERE org_id = ?) >= ?`,
        [
          `led_${crypto.randomUUID()}`,
          organizationId,
          reference,
          -amountMinor,
          clock().toISOString(),
          organizationId,
          reference,
          organizationId,
          amountMinor,
        ],
      );
      if (written.changes === 1) return true;
      const existing = await sql.query(
        `SELECT settled_delta, held_delta FROM ledger
         WHERE org_id = ? AND type = 'usage_debit' AND ref = ?`,
        [organizationId, reference],
      );
      return (
        existing.length === 1 &&
        Number(existing[0]?.settled_delta) === -amountMinor &&
        Number(existing[0]?.held_delta) === 0
      );
    },
  };
}

function positiveAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new LedgerError("invalid_amount");
  return value;
}
