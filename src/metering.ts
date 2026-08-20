import type { AiUsage } from "./ai-port.ts";
import type { PricedUsage } from "./catalog.ts";
import { canonicalDigest } from "./json.ts";
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
 * The fold claims rows before it writes the debit. A later attempt first
 * recovers every claimed group without a matching ledger entry, so a process
 * stop between those two writes cannot lose usage. The ledger accepts the
 * debit only when prepaid funds cover it; otherwise the claim remains durable
 * and retryable rather than overdrawing the Wallet.
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
  recordProviderWindow(usage: {
    readonly organizationId: string;
    readonly resourceUid: string;
    readonly deploymentId: string;
    readonly meterSourceId: string;
    readonly from: string;
    readonly until: string;
    readonly priced: PricedUsage;
  }): Promise<void>;
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

  const settleClaim = async (claim: {
    readonly rollupId: string;
    readonly organizationId: string;
    readonly count: number;
    readonly micros: number;
  }): Promise<boolean> => {
    const amountMinor = Math.round(claim.micros / 1_000_000);
    if (amountMinor === 0) return true;
    return await ledger.debitUsage({
      organizationId: claim.organizationId,
      reference: claim.rollupId,
      amountMinor,
    });
  };

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

    async recordProviderWindow(usage) {
      const windowDigest = await canonicalDigest({
        organizationId: usage.organizationId,
        resourceUid: usage.resourceUid,
        deploymentId: usage.deploymentId,
        meterSourceId: usage.meterSourceId,
        from: usage.from,
        until: usage.until,
      });
      for (const line of usage.priced.lines) {
        if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor < 0) {
          throw new TypeError("provider usage price invalid");
        }
        const micros = line.amountMinor * 1_000_000;
        if (!Number.isSafeInteger(micros)) throw new TypeError("provider usage price overflow");
        await sql.run(
          `INSERT OR IGNORE INTO usage_events
             (request_id, org_id, resource_uid, meter, quantity, amount_minor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            `provider:${windowDigest.slice(7)}:${line.meter}`,
            usage.organizationId,
            usage.resourceUid,
            line.meter,
            line.quantity,
            micros,
            clock().toISOString(),
          ],
        );
      }
    },

    async rollUp(limit) {
      const boundedLimit = Math.min(Math.max(limit, 1), 1_000);
      let moved = 0;
      const blockedOrganizations = new Set<string>();

      // A prior process may have claimed rows and stopped before debiting the
      // ledger. Resume those exact groups first. Groups that round to zero need
      // no ledger row and are already final.
      const recoverable = await sql.query(
        `SELECT events.rollup_id, events.org_id, COUNT(*) AS event_count,
                SUM(events.amount_minor) AS amount_micros
         FROM usage_events AS events
         LEFT JOIN ledger AS debit
           ON debit.org_id = events.org_id
          AND debit.type = 'usage_debit'
          AND debit.ref = events.rollup_id
         WHERE events.rollup_id IS NOT NULL AND debit.id IS NULL
         GROUP BY events.rollup_id, events.org_id
         HAVING SUM(events.amount_minor) >= 500000
         ORDER BY MIN(events.created_at) ASC, events.rollup_id ASC
         LIMIT ?`,
        [boundedLimit],
      );
      for (const row of recoverable) {
        const claim = {
          rollupId: String(row.rollup_id),
          organizationId: String(row.org_id),
          count: Number(row.event_count),
          micros: Number(row.amount_micros),
        };
        if (await settleClaim(claim)) moved += claim.count;
        else blockedOrganizations.add(claim.organizationId);
      }
      if (moved >= boundedLimit) return moved;

      const blockedClause =
        blockedOrganizations.size === 0
          ? ""
          : ` AND org_id NOT IN (${[...blockedOrganizations].map(() => "?").join(", ")})`;
      const pending = await sql.query(
        `SELECT request_id, org_id, amount_minor FROM usage_events
         WHERE rollup_id IS NULL${blockedClause}
         ORDER BY created_at ASC LIMIT ?`,
        [...blockedOrganizations, boundedLimit - moved],
      );
      if (pending.length === 0) return moved;

      const byOrg = new Map<string, { ids: string[]; micros: number }>();
      for (const row of pending) {
        const organizationId = String(row.org_id);
        const entry = byOrg.get(organizationId) ?? { ids: [], micros: 0 };
        entry.ids.push(String(row.request_id));
        entry.micros += Number(row.amount_minor);
        byOrg.set(organizationId, entry);
      }

      for (const [organizationId, entry] of byOrg) {
        const rollupId = `roll_${randomId()}`;
        const claimed = await sql.run(
          `UPDATE usage_events SET rollup_id = ?
           WHERE rollup_id IS NULL AND request_id IN (${entry.ids.map(() => "?").join(", ")})`,
          [rollupId, ...entry.ids],
        );
        if (claimed.changes === 0) continue;
        const actual = await sql.query(
          `SELECT COUNT(*) AS event_count, SUM(amount_minor) AS amount_micros
           FROM usage_events WHERE org_id = ? AND rollup_id = ?`,
          [organizationId, rollupId],
        );
        const claim = {
          rollupId,
          organizationId,
          count: Number(actual[0]?.event_count ?? 0),
          micros: Number(actual[0]?.amount_micros ?? 0),
        };
        if (await settleClaim(claim)) moved += claim.count;
      }
      return moved;
    },
  };
}
