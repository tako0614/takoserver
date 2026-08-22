import { asc, isNull } from "drizzle-orm";
import type { AiUsage } from "./ai-port.ts";
import type { PricedUsage } from "./catalog.ts";
import { createDatabase } from "./database.ts";
import { usageEvents } from "./database-schema.ts";
import { canonicalDigest } from "./json.ts";
import { type Ledger, LedgerError } from "./ledger.ts";
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
 * The fold claims rows before it writes the debit. If prepaid funds cannot
 * cover that exact batch, it releases only its own claim and fails, leaving the
 * usage pending for funding or suspension policy rather than silently marking
 * uncharged usage as billed.
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
  const db = createDatabase(sql);
  const bytesRate = options.rates?.bytesMinorPerGibibyte ?? 0;
  const requestRate = options.rates?.requestsMinorPerThousand ?? 0;

  return {
    async record(usage) {
      // Fractional at the point of measurement, rounded once at the fold. A
      // per-request round to whole minor units would charge a hundredth of a
      // cent as a cent, several thousand times an hour.
      const amount = (usage.bytes / GIBIBYTE) * bytesRate + requestRate / 1_000;
      await db
        .insert(usageEvents)
        .values({
          requestId: usage.requestId,
          organizationId: usage.organizationId,
          resourceUid: usage.resourceUid,
          meter: `object.${usage.operation}`,
          quantity: usage.bytes,
          amountMicros: Math.round(amount * 1_000_000),
          createdAt: clock().toISOString(),
        })
        .onConflictDoNothing()
        .run();
    },

    async recordAi(usage) {
      await db
        .insert(usageEvents)
        .values({
          requestId: usage.requestId,
          organizationId: usage.organizationId,
          resourceUid: `ai/${usage.model}`,
          meter: `ai.tokens.${usage.model}`,
          quantity: usage.inputTokens + usage.outputTokens,
          amountMicros: 0,
          createdAt: clock().toISOString(),
        })
        .onConflictDoNothing()
        .run();
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
        if (!Number.isSafeInteger(line.amountMicros) || line.amountMicros < 0) {
          throw new TypeError("provider usage price invalid");
        }
        await db
          .insert(usageEvents)
          .values({
            requestId: `provider:${windowDigest.slice(7)}:${line.meter}`,
            organizationId: usage.organizationId,
            resourceUid: usage.resourceUid,
            meter: line.meter,
            quantity: line.quantity,
            amountMicros: line.amountMicros,
            createdAt: clock().toISOString(),
          })
          .onConflictDoNothing()
          .run();
      }
    },

    async rollUp(limit) {
      const pending = await db
        .select({
          requestId: usageEvents.requestId,
          organizationId: usageEvents.organizationId,
          amountMicros: usageEvents.amountMicros,
        })
        .from(usageEvents)
        .where(isNull(usageEvents.rollupId))
        .orderBy(asc(usageEvents.createdAt))
        .limit(Math.min(Math.max(limit, 1), 1_000));
      if (pending.length === 0) return 0;

      const byOrg = new Map<string, { ids: string[]; micros: number }>();
      for (const row of pending) {
        const organizationId = row.organizationId;
        const entry = byOrg.get(organizationId) ?? { ids: [], micros: 0 };
        entry.ids.push(row.requestId);
        entry.micros += row.amountMicros;
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
        // Rounded once, here, for everything the fold covers. Zero is a real
        // answer and is not written: a ledger full of nothing is a ledger
        // nobody reads.
        const amountMinor = Math.round(entry.micros / 1_000_000);
        if (amountMinor > 0) {
          const charged = await ledger.debitUsage({
            organizationId,
            reference: rollupId,
            amountMinor,
          });
          if (!charged) {
            const released = await sql.run(
              "UPDATE usage_events SET rollup_id = NULL WHERE rollup_id = ?",
              [rollupId],
            );
            if (released.changes !== claimed.changes) {
              throw new LedgerError("conservation_violated");
            }
            throw new LedgerError("insufficient_funds");
          }
        }
        moved += claimed.changes;
      }
      return moved;
    },
  };
}
