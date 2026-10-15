import { asc, isNull } from "drizzle-orm";
import type { AiUsage } from "./ai-port.ts";
import type { PricedUsage } from "./catalog.ts";
import { createDatabase } from "./database.ts";
import { usageEvents } from "./database-schema.ts";
import { canonicalDigest } from "./json.ts";
import {
  type Ledger,
  type LedgerAllocationAdmission,
  LedgerError,
  prepareLedgerAllocation,
} from "./ledger.ts";
import {
  addRational,
  ceilPricedMicros,
  decimalRational,
  floorPricedMicros,
  parsePricedRational,
  type RationalMicros,
  rational,
} from "./meter-pricing.ts";
import { minorToMicros } from "./money.ts";
import { type OrgLimitAdmission, PREPAID_CONSENT_REVISION } from "./org-limit-policy.ts";
import { type Clock, type Row, type Sql, SqlError, type SqlStatement } from "./ports.ts";

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
 * A fold claims its exact priced rows and writes the matching debit in one
 * atomic batch. If the rows or prepaid funds are lost to another writer, the
 * whole batch fails and unclaimed usage remains pending.
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

const GIBIBYTE = 1_024n * 1_024n * 1_024n;
type MeteringEvent = typeof usageEvents.$inferInsert;

function admissionWitness(admission: OrgLimitAdmission): string {
  const witness = {
    onLimit: admission.onLimit,
    policyVersion: admission.policyVersion,
    consentRevision: admission.consentRevision,
    allowPurchasedCredit: admission.allowPurchasedCredit,
  };
  const encoded = JSON.stringify(witness);
  purchasedAdmission(encoded);
  return encoded;
}

function purchasedAdmission(witness: unknown): boolean {
  // Historical measurements have no original purchase consent to infer.
  if (witness === null) return false;
  if (typeof witness !== "string") throw new LedgerError("conservation_violated");
  let value: unknown;
  try {
    value = JSON.parse(witness);
  } catch {
    throw new LedgerError("conservation_violated");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LedgerError("conservation_violated");
  const p = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(p.policyVersion) ||
    Number(p.policyVersion) < 0 ||
    (p.onLimit === "stop"
      ? p.allowPurchasedCredit !== false || p.consentRevision !== null
      : p.onLimit !== "prepaid" ||
        p.allowPurchasedCredit !== true ||
        Number(p.policyVersion) < 1 ||
        p.consentRevision !== PREPAID_CONSENT_REVISION)
  )
    throw new LedgerError("conservation_violated");
  return p.allowPurchasedCredit === true;
}

function sameEvent(row: Row, event: MeteringEvent): boolean {
  return (
    row.org_id === event.organizationId &&
    row.resource_uid === event.resourceUid &&
    row.meter === event.meter &&
    row.quantity === event.quantity &&
    row.amount_micros === event.amountMicros &&
    row.amount_unit === event.amountUnit &&
    row.amount_numerator_micros === event.amountNumeratorMicros &&
    row.amount_denominator === event.amountDenominator
  );
}

export function createMetering(options: {
  readonly sql: Sql;
  readonly ledger: Ledger;
  readonly clock: Clock;
  readonly randomId: () => string;
  readonly rates?: MeteringRates;
  readonly hostedPaidFreeExclusion?: boolean;
  /** Qualified composition supplies the same policy resolver as its ledger. */
  readonly allocationAdmissionResolver?: (organizationId: string) => Promise<OrgLimitAdmission>;
}): Metering {
  const { sql, clock, randomId } = options;
  const db = createDatabase(sql);
  const bytesRate = BigInt(minorToMicros(options.rates?.bytesMinorPerGibibyte ?? 0));
  const requestRate = BigInt(minorToMicros(options.rates?.requestsMinorPerThousand ?? 0));

  async function recordEvent(event: MeteringEvent): Promise<void> {
    if (!options.allocationAdmissionResolver) {
      await db.insert(usageEvents).values(event).onConflictDoNothing().run();
      return;
    }
    const existing = async () =>
      (await sql.query("SELECT * FROM usage_events WHERE request_id = ?", [event.requestId]))[0];
    const replay = await existing();
    if (replay) {
      if (!sameEvent(replay, event)) throw new LedgerError("conservation_violated");
      return;
    }
    const admission = await options.allocationAdmissionResolver(event.organizationId);
    const witness = admissionWitness(admission);
    const id = `guard_${crypto.randomUUID()}`;
    try {
      await sql.batch([
        admission.guard,
        {
          sql: `INSERT OR IGNORE INTO usage_events
            (request_id, org_id, resource_uid, meter, quantity, amount_micros,
             amount_unit, amount_numerator_micros, amount_denominator, created_at,
             admission_policy_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            event.requestId,
            event.organizationId,
            event.resourceUid,
            event.meter,
            event.quantity,
            event.amountMicros,
            event.amountUnit,
            event.amountNumeratorMicros ?? null,
            event.amountDenominator ?? null,
            event.createdAt,
            witness,
          ],
        },
        {
          sql: `INSERT INTO wallet_allocation_guards (id, valid)
            VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM usage_events
              WHERE request_id = ? AND org_id = ? AND resource_uid = ? AND meter = ?
                AND quantity = ? AND amount_micros = ? AND amount_unit = ?
                AND amount_numerator_micros IS ? AND amount_denominator IS ?
                AND admission_policy_json = ?) THEN 1 ELSE 0 END)`,
          params: [
            id,
            event.requestId,
            event.organizationId,
            event.resourceUid,
            event.meter,
            event.quantity,
            event.amountMicros,
            event.amountUnit,
            event.amountNumeratorMicros ?? null,
            event.amountDenominator ?? null,
            witness,
          ],
        },
        { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [id] },
        admission.cleanup,
      ]);
    } catch (error) {
      if (error instanceof SqlError) {
        const committed = await existing();
        if (committed && sameEvent(committed, event)) return;
      }
      throw error;
    }
  }

  return {
    async record(usage) {
      // Retain exact priced evidence. Quantize the complete claimed fold to
      // one USD micro only at settlement, never each request or to cents.
      const quantity = decimalRational(usage.bytes);
      const amount = addRational(
        rational(quantity.numerator * bytesRate, quantity.denominator * GIBIBYTE),
        rational(requestRate, 1_000n),
      );
      await recordEvent({
        requestId: usage.requestId,
        organizationId: usage.organizationId,
        resourceUid: usage.resourceUid,
        meter: `object.${usage.operation}`,
        quantity: usage.bytes,
        amountMicros: floorPricedMicros(amount),
        amountUnit: "usd-micros-v2",
        amountNumeratorMicros: String(amount.numerator),
        amountDenominator: String(amount.denominator),
        createdAt: clock().toISOString(),
      });
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
          amountUnit: "usd-micros-v2",
          amountNumeratorMicros: "0",
          amountDenominator: "1",
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
        const exact = parsePricedRational(line.amountNumeratorMicros, line.amountDenominator);
        if (
          usage.priced.amountUnit !== "usd-micros-v2" ||
          line.amountMicros !== floorPricedMicros(exact)
        ) {
          throw new TypeError("provider usage price invalid");
        }
        await recordEvent({
          requestId: `provider:${windowDigest.slice(7)}:${line.meter}`,
          organizationId: usage.organizationId,
          resourceUid: usage.resourceUid,
          meter: line.meter,
          quantity: line.quantity,
          amountMicros: line.amountMicros,
          amountUnit: "usd-micros-v2",
          amountNumeratorMicros: line.amountNumeratorMicros,
          amountDenominator: line.amountDenominator,
          createdAt: clock().toISOString(),
        });
      }
    },

    async rollUp(limit) {
      const pending = await db
        .select({
          requestId: usageEvents.requestId,
          organizationId: usageEvents.organizationId,
          amountUnit: usageEvents.amountUnit,
          amountNumeratorMicros: usageEvents.amountNumeratorMicros,
          amountDenominator: usageEvents.amountDenominator,
        })
        .from(usageEvents)
        .where(isNull(usageEvents.rollupId))
        .orderBy(asc(usageEvents.createdAt))
        .limit(Math.min(Math.max(limit, 1), 1_000));
      if (pending.length === 0) return 0;

      const witnesses = options.allocationAdmissionResolver
        ? new Map(
            (
              await sql.query(
                `SELECT request_id, admission_policy_json FROM usage_events
           WHERE request_id IN (SELECT value FROM json_each(?))`,
                [JSON.stringify(pending.map(({ requestId }) => requestId))],
              )
            ).map((row) => [String(row.request_id), row.admission_policy_json]),
          )
        : undefined;

      const byOrg = new Map<string, typeof pending>();
      for (const row of pending) {
        const organizationId = row.organizationId;
        const entry = byOrg.get(organizationId) ?? [];
        entry.push(row);
        byOrg.set(organizationId, entry);
      }

      let moved = 0;
      for (const [organizationId, rows] of byOrg) {
        const rollupId = `roll_${randomId()}`;
        const ids = rows.map((row) => row.requestId);
        const idsJson = JSON.stringify(ids);
        let exact: RationalMicros = rational(0n);
        let allowPurchasedCredit = true;
        for (const row of rows) {
          if (row.amountUnit !== "usd-micros-v2") throw new LedgerError("conservation_violated");
          const priced = parsePricedRational(row.amountNumeratorMicros, row.amountDenominator);
          exact = addRational(exact, priced);
          if (witnesses && priced.numerator > 0n)
            allowPurchasedCredit =
              purchasedAdmission(witnesses.get(row.requestId)) && allowPurchasedCredit;
        }
        const amountMicros = ceilPricedMicros(exact);
        const guardId = `guard_${crypto.randomUUID()}`;
        const sourceGuardId = `${guardId}_admission`;
        const admission: LedgerAllocationAdmission | undefined = witnesses
          ? {
              // Keep one aggregate ceiling. Mixed original decisions use their
              // eligibility intersection, never a newer permissive policy.
              allowPurchasedCredit,
              guard: {
                sql: `INSERT INTO wallet_allocation_guards (id, valid)
              VALUES (?, CASE WHEN (SELECT COUNT(*) FROM json_each(?) wanted
                JOIN usage_events e ON e.request_id = json_extract(wanted.value, '$[0]')
                  AND e.org_id = ?
                  AND e.admission_policy_json IS json_extract(wanted.value, '$[1]')) = ?
                THEN 1 ELSE 0 END)`,
                params: [
                  sourceGuardId,
                  JSON.stringify(
                    rows.map(({ requestId }) => [requestId, witnesses.get(requestId)]),
                  ),
                  organizationId,
                  rows.length,
                ],
              },
              cleanup: {
                sql: "DELETE FROM wallet_allocation_guards WHERE id = ?",
                params: [sourceGuardId],
              },
            }
          : undefined;
        const statements: SqlStatement[] = [
          {
            // Check the whole immutable candidate set before the first write.
            // A previously used zero-cost rollup has no ledger row, so also
            // prove that this reference owns no usage rows yet.
            sql: `INSERT INTO wallet_allocation_guards (id, valid)
                  VALUES (?, CASE WHEN
                    (SELECT COUNT(*) FROM usage_events
                     WHERE org_id = ? AND rollup_id IS NULL
                       AND request_id IN (SELECT value FROM json_each(?))) = ?
                    AND NOT EXISTS (SELECT 1 FROM usage_events
                                    WHERE org_id = ? AND rollup_id = ?)
                    AND NOT EXISTS (SELECT 1 FROM ledger
                                    WHERE org_id = ? AND type = 'usage_debit' AND ref = ?)
                    AND NOT EXISTS (SELECT 1 FROM wallet_credit_allocations
                                    WHERE org_id = ? AND debit_type = 'usage_debit' AND debit_ref = ?)
                    THEN 1 ELSE 0 END)`,
            params: [
              guardId,
              organizationId,
              idsJson,
              ids.length,
              organizationId,
              rollupId,
              organizationId,
              rollupId,
              organizationId,
              rollupId,
            ],
          },
          {
            sql: `UPDATE usage_events SET rollup_id = ?
                  WHERE org_id = ? AND rollup_id IS NULL
                    AND request_id IN (SELECT value FROM json_each(?))`,
            params: [rollupId, organizationId, idsJson],
          },
          {
            // Prove the update actually assigned every intended ID. This is
            // checked in the same batch before its matching ledger debit.
            sql: `UPDATE wallet_allocation_guards SET valid = CASE WHEN
                    (SELECT COUNT(*) FROM usage_events
                     WHERE org_id = ? AND rollup_id = ?
                       AND request_id IN (SELECT value FROM json_each(?))) = ?
                    AND (SELECT COUNT(*) FROM usage_events
                         WHERE org_id = ? AND rollup_id = ?) = ?
                    THEN 1 ELSE 0 END WHERE id = ?`,
            params: [
              organizationId,
              rollupId,
              idsJson,
              ids.length,
              organizationId,
              rollupId,
              ids.length,
              guardId,
            ],
          },
        ];
        if (amountMicros > 0) {
          statements.push(
            ...(await prepareLedgerAllocation(sql, {
              organizationId,
              type: "usage_debit",
              reference: rollupId,
              amountMicros,
              settledDeltaMicros: -amountMicros,
              heldDeltaMicros: 0,
              now: clock().toISOString(),
              hostedPaidFreeExclusion: options.hostedPaidFreeExclusion === true,
              ...(admission ? { allocationAdmission: admission } : {}),
            })),
          );
        }
        statements.push({
          sql: "DELETE FROM wallet_allocation_guards WHERE id = ?",
          params: [guardId],
        });
        await sql.batch(statements);
        moved += ids.length;
      }
      return moved;
    },
  };
}
