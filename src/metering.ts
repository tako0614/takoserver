import type { AiUsage } from "./ai-port.ts";
import type { Ledger } from "./ledger.ts";
import type { Clock, Sql } from "./ports.ts";

/**
 * Counting what the data plane moved, and charging for it.
 *
 * Two things kept apart on purpose. **Measurement** is a fact: so many bytes,
 * so many requests, at a time, for a resource. **Price** is a decision, and it
 * is the operator's — so the rates default to nothing and a deployment that has
 * not decided what data costs records the usage and charges zero rather than
 * inventing a number nobody agreed to.
 *
 * Each request is one row keyed by its own id, so a retry is counted once. The
 * rows are folded into a single ledger entry per organization rather than one
 * per request: a wallet that lists every object read is a wallet nobody can
 * read, and the events remain for anyone who wants the detail.
 *
 * The fold marks the rows it took before it writes the debit, and the debit's
 * reference is the fold's own id — so the ledger's uniqueness makes a repeated
 * fold a no-op, and a fold interrupted between the two steps leaves rows
 * marked with a debit that will be written by the next attempt under the same
 * reference.
 */

export interface MeteringRates {
  /** Charged per gibibyte transferred, in minor units. */
  readonly bytesMinorPerGibibyte?: number;
  /** Charged per thousand requests, in minor units. */
  readonly requestsMinorPerThousand?: number;
}

/** One measured request. */
export interface UsageRecord {
  readonly requestId: string;
  readonly organizationId: string;
  readonly resourceUid: string;
  readonly operation: string;
  readonly bytes: number;
}

export interface Metering {
  record(usage: UsageRecord): Promise<void>;
  /** Records already-settled AI token usage without charging it twice. */
  recordAi(usage: AiUsage): Promise<void>;
  /** Folds unbilled usage into ledger entries. Returns how many rows moved. */
  rollUp(limit: number): Promise<number>;
}

const GIBIBYTE = 1_024 * 1_024 * 1_024;

export function createMetering(options: {
  readonly sql: Sql;
  readonly ledger: Ledger;
  readonly clock: Clock;
  readonly randomId: () => string;
  readonly rates?: MeteringRates;
}): Metering {
  const { sql, ledger, clock, randomId } = options;
  const bytesRate = options.rates?.bytesMinorPerGibibyte ?? 0;
  const requestRate = options.rates?.requestsMinorPerThousand ?? 0;

  return {
    async record(usage) {
      // Fractional at the point of measurement, rounded once at the fold. A
      // per-request round to whole minor units would charge a hundredth of a
      // cent as a cent, several thousand times an hour.
      const amount = (usage.bytes / GIBIBYTE) * bytesRate + requestRate / 1_000;
      await sql.run(
        `INSERT OR IGNORE INTO usage_events
           (request_id, org_id, resource_uid, meter, quantity, amount_minor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          usage.requestId,
          usage.organizationId,
          usage.resourceUid,
          `object.${usage.operation}`,
          usage.bytes,
          Math.round(amount * 1_000_000),
          clock().toISOString(),
        ],
      );
    },

    async recordAi(usage) {
      await sql.run(
        `INSERT OR IGNORE INTO usage_events
           (request_id, org_id, resource_uid, meter, quantity, amount_minor, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
        [
          usage.requestId,
          usage.organizationId,
          `ai/${usage.model}`,
          `ai.tokens.${usage.model}`,
          usage.inputTokens + usage.outputTokens,
          clock().toISOString(),
        ],
      );
    },

    async rollUp(limit) {
      const pending = await sql.query(
        `SELECT request_id, org_id, amount_minor FROM usage_events
         WHERE rollup_id IS NULL ORDER BY created_at ASC LIMIT ?`,
        [Math.min(Math.max(limit, 1), 1_000)],
      );
      if (pending.length === 0) return 0;

      const byOrg = new Map<string, { ids: string[]; micros: number }>();
      for (const row of pending) {
        const organizationId = String(row.org_id);
        const entry = byOrg.get(organizationId) ?? { ids: [], micros: 0 };
        entry.ids.push(String(row.request_id));
        entry.micros += Number(row.amount_minor);
        byOrg.set(organizationId, entry);
      }

      let moved = 0;
      for (const [organizationId, entry] of byOrg) {
        const rollupId = `roll_${randomId()}`;
        const claimed = await sql.run(
          `UPDATE usage_events SET rollup_id = ?
           WHERE rollup_id IS NULL AND request_id IN (${entry.ids.map(() => "?").join(", ")})`,
          [rollupId, ...entry.ids],
        );
        if (claimed.changes === 0) continue;
        moved += claimed.changes;

        // Rounded once, here, for everything the fold covers. Zero is a real
        // answer and is not written: a ledger full of nothing is a ledger
        // nobody reads.
        const amountMinor = Math.round(entry.micros / 1_000_000);
        if (amountMinor > 0) {
          await ledger.debitUsage({ organizationId, reference: rollupId, amountMinor });
        }
      }
      return moved;
    },
  };
}
