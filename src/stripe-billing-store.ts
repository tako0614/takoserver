import type { Clock, Row, Sql, SqlStatement } from "./ports.ts";

export interface BillingGrant {
  readonly organizationId: string;
  readonly fundingRef: string;
  readonly kind: "purchased" | "plan-included";
  readonly amountMicros: number;
  readonly expiresAt: string | null;
  readonly sourceType: "checkout" | "invoice";
  readonly sourceId: string;
  readonly chargeId: string;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly planKey: string | null;
  readonly pricingRevision: string | null;
  readonly stripePriceId: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly considerationMicros: number;
}

export interface RefundReceipt {
  readonly refundId: string;
  readonly organizationId: string;
  readonly fundingRef: string;
  readonly amountMicros: number;
  readonly cumulativeRefundedMicros: number;
  readonly targetRevokedMicros: number;
  readonly debitMicros: number;
  readonly receivableMicros: number;
  readonly expiredMicros: number;
  readonly createdAt: string;
}

export class StripeBillingStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StripeBillingStoreError";
  }
}

function fail(code: string): never {
  throw new StripeBillingStoreError(code);
}

function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_amount");
}

function optionalTime(value: string | null): void {
  if (
    value !== null &&
    (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
  )
    fail("invalid_time");
}

function grantFrom(row: Row): BillingGrant {
  return {
    organizationId: String(row.org_id),
    fundingRef: String(row.funding_ref),
    kind: row.kind as BillingGrant["kind"],
    amountMicros: Number(row.amount_micros),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    sourceType: row.source_type as BillingGrant["sourceType"],
    sourceId: String(row.source_id),
    chargeId: String(row.charge_id),
    customerId: row.customer_id == null ? null : String(row.customer_id),
    subscriptionId: row.subscription_id == null ? null : String(row.subscription_id),
    planKey: row.plan_key == null ? null : String(row.plan_key),
    pricingRevision: row.pricing_revision == null ? null : String(row.pricing_revision),
    stripePriceId: row.stripe_price_id == null ? null : String(row.stripe_price_id),
    periodStart: row.period_start == null ? null : String(row.period_start),
    periodEnd: row.period_end == null ? null : String(row.period_end),
    considerationMicros: Number(row.consideration_micros),
  };
}

function receiptFrom(row: Row): RefundReceipt {
  return {
    refundId: String(row.refund_id),
    organizationId: String(row.org_id),
    fundingRef: String(row.funding_ref),
    amountMicros: Number(row.amount_micros),
    cumulativeRefundedMicros: Number(row.cumulative_refunded_micros),
    targetRevokedMicros: Number(row.target_revoked_micros),
    debitMicros: Number(row.debit_micros),
    receivableMicros: Number(row.receivable_micros),
    expiredMicros: Number(row.expired_micros),
    createdAt: String(row.created_at),
  };
}

function sameGrant(a: BillingGrant, b: BillingGrant): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.fundingRef === b.fundingRef &&
    a.kind === b.kind &&
    a.amountMicros === b.amountMicros &&
    a.expiresAt === b.expiresAt &&
    a.sourceType === b.sourceType &&
    a.sourceId === b.sourceId &&
    a.chargeId === b.chargeId &&
    a.customerId === b.customerId &&
    a.subscriptionId === b.subscriptionId &&
    a.planKey === b.planKey &&
    a.pricingRevision === b.pricingRevision &&
    a.stripePriceId === b.stripePriceId &&
    a.periodStart === b.periodStart &&
    a.periodEnd === b.periodEnd &&
    a.considerationMicros === b.considerationMicros
  );
}

function guard(
  id: string,
  condition: string,
  params: readonly (string | number | null)[] = [],
): SqlStatement {
  return {
    sql: `INSERT INTO wallet_allocation_guards (id, valid) VALUES (?, CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
    params: [id, ...params],
  };
}

export function createStripeBillingStore(options: { readonly sql: Sql; readonly clock: Clock }) {
  const { sql, clock } = options;
  const at = () => clock().toISOString();
  const source = async (type: BillingGrant["sourceType"], id: string) => {
    const rows = await sql.query(
      "SELECT * FROM stripe_billing_grants WHERE source_type = ? AND source_id = ?",
      [type, id],
    );
    return rows[0] ? grantFrom(rows[0]) : null;
  };
  const receipt = async (id: string) => {
    const rows = await sql.query("SELECT * FROM stripe_billing_refunds WHERE refund_id = ?", [id]);
    return rows[0] ? receiptFrom(rows[0]) : null;
  };

  return {
    grantForSource: source,
    async grantsForCharge(chargeId: string): Promise<readonly BillingGrant[]> {
      return (
        await sql.query(
          "SELECT * FROM stripe_billing_grants WHERE charge_id = ? ORDER BY source_type, source_id",
          [chargeId],
        )
      ).map(grantFrom);
    },
    async grantForCharge(chargeId: string): Promise<BillingGrant | null> {
      const rows = await this.grantsForCharge(chargeId);
      if (rows.length > 1) fail("ambiguous_charge");
      return rows[0] ?? null;
    },
    async grant(input: BillingGrant): Promise<void> {
      if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros < 0) fail("invalid_amount");
      positive(input.considerationMicros);
      if (input.kind === "purchased" && input.amountMicros !== input.considerationMicros)
        fail("invalid_purchase_consideration");
      if (
        !input.organizationId ||
        !input.fundingRef ||
        !input.sourceId ||
        !input.chargeId ||
        (input.kind === "purchased" && input.sourceType !== "checkout") ||
        (input.kind === "plan-included" && input.sourceType !== "invoice") ||
        (input.sourceType === "invoice" &&
          (!input.subscriptionId ||
            !input.planKey ||
            !input.pricingRevision ||
            !input.stripePriceId ||
            !input.periodStart ||
            !input.periodEnd ||
            input.periodStart >= input.periodEnd))
      )
        fail("invalid_grant");
      for (const value of [input.expiresAt, input.periodStart, input.periodEnd])
        optionalTime(value);
      const existing = await source(input.sourceType, input.sourceId);
      if (existing) {
        if (!sameGrant(existing, input)) fail("grant_conflict");
        return;
      }
      const now = at();
      const oldLot = (
        await sql.query(
          "SELECT kind, consumption_class, amount_micros, expires_at FROM wallet_credit_lots WHERE org_id = ? AND ref = ?",
          [input.organizationId, input.fundingRef],
        )
      )[0];
      const legacyLot =
        oldLot !== undefined &&
        input.kind === "purchased" &&
        input.sourceType === "checkout" &&
        input.fundingRef === `stripe:${input.sourceId}` &&
        input.expiresAt === null &&
        oldLot.kind === "direct" &&
        oldLot.consumption_class === "purchased" &&
        Number(oldLot.amount_micros) === input.amountMicros &&
        oldLot.expires_at === null;
      if (oldLot && !legacyLot) fail("grant_conflict");
      const legacyGuard = `guard_${crypto.randomUUID()}`;
      const moneyGuard = `guard_${crypto.randomUUID()}`;
      try {
        await sql.batch([
          ...(legacyLot
            ? [
                guard(
                  legacyGuard,
                  `EXISTS (SELECT 1 FROM wallet_credit_lots l JOIN ledger e
              ON e.org_id = l.org_id AND e.ref = l.ref AND e.type = 'funding'
              WHERE l.org_id = ? AND l.ref = ? AND l.kind = 'direct'
                AND l.consumption_class = 'purchased'
                AND l.amount_micros = ? AND l.expires_at IS NULL
                AND e.settled_delta_micros = ? AND e.held_delta_micros = 0)
              AND NOT EXISTS (SELECT 1 FROM stripe_billing_grants
                WHERE org_id = ? AND funding_ref = ?)`,
                  [
                    input.organizationId,
                    input.fundingRef,
                    input.amountMicros,
                    input.amountMicros,
                    input.organizationId,
                    input.fundingRef,
                  ],
                ),
              ]
            : []),
          ...(input.amountMicros > 0 && !legacyLot
            ? [
                {
                  sql: `INSERT INTO wallet_credit_lots (org_id, ref, kind, consumption_class, amount_micros, expires_at, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  params: [
                    input.organizationId,
                    input.fundingRef,
                    input.kind,
                    input.kind === "purchased" ? "purchased" : "subscription",
                    input.amountMicros,
                    input.expiresAt,
                    now,
                  ],
                },
                {
                  sql: `INSERT INTO ledger (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at)
                  VALUES (?, ?, 'funding', ?, ?, 0, ?)`,
                  params: [
                    `led_${crypto.randomUUID()}`,
                    input.organizationId,
                    input.fundingRef,
                    input.amountMicros,
                    now,
                  ],
                },
              ]
            : []),
          {
            sql: `INSERT INTO stripe_billing_grants
              (org_id, funding_ref, kind, consumption_class, amount_micros, expires_at, source_type, source_id, charge_id,
               customer_id, subscription_id, plan_key, pricing_revision, stripe_price_id,
               period_start, period_end, consideration_micros, legacy_lot, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              input.organizationId,
              input.fundingRef,
              input.kind,
              input.kind === "purchased" ? "purchased" : "subscription",
              input.amountMicros,
              input.expiresAt,
              input.sourceType,
              input.sourceId,
              input.chargeId,
              input.customerId,
              input.subscriptionId,
              input.planKey,
              input.pricingRevision,
              input.stripePriceId,
              input.periodStart,
              input.periodEnd,
              input.considerationMicros,
              legacyLot ? 1 : 0,
              now,
            ],
          },
          ...(input.amountMicros > 0 && !legacyLot ? [guard(moneyGuard,
            `EXISTS (SELECT 1 FROM wallet_credit_lots l JOIN ledger e
              ON e.org_id = l.org_id AND e.ref = l.ref AND e.type = 'funding'
              WHERE l.org_id = ? AND l.ref = ? AND l.kind = ?
                AND l.consumption_class = ? AND l.amount_micros = ? AND l.expires_at IS ?
                AND e.settled_delta_micros = ? AND e.held_delta_micros = 0)
             AND (SELECT COALESCE(SUM(held_delta_micros), 0) FROM ledger WHERE org_id = ?)
                 = (SELECT COALESCE(SUM(amount_micros), 0) FROM wallet_credit_allocations
                    WHERE org_id = ? AND debit_type = 'hold')
             AND (SELECT COALESCE(SUM(held_delta_micros), 0) FROM ledger WHERE org_id = ?)
                 BETWEEN 0 AND 9007199254740991
             AND (SELECT COALESCE(SUM(CASE
                 WHEN l.expires_at IS NULL OR l.expires_at > ? THEN
                   l.amount_micros - COALESCE((SELECT SUM(a.amount_micros)
                     FROM wallet_credit_allocations a WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
                       AND a.debit_type IN ('capture', 'usage_debit')), 0)
                   - COALESCE((SELECT SUM(r.debit_micros) FROM stripe_billing_refunds r
                     WHERE r.org_id = l.org_id AND r.funding_ref = l.ref), 0)
                 ELSE COALESCE((SELECT SUM(a.amount_micros)
                   FROM wallet_credit_allocations a WHERE a.org_id = l.org_id AND a.lot_ref = l.ref
                     AND a.debit_type = 'hold'), 0) END), 0)
               FROM wallet_credit_lots l WHERE l.org_id = ?)
                 BETWEEN (SELECT COALESCE(SUM(held_delta_micros), 0) FROM ledger WHERE org_id = ?)
                     AND 9007199254740991`,
            [input.organizationId, input.fundingRef, input.kind,
              input.kind === "purchased" ? "purchased" : "subscription",
              input.amountMicros, input.expiresAt, input.amountMicros,
              input.organizationId, input.organizationId, input.organizationId,
              now, input.organizationId, input.organizationId])] : []),
          ...(legacyLot
            ? [
                {
                  sql: "DELETE FROM wallet_allocation_guards WHERE id = ?",
                  params: [legacyGuard],
                },
              ]
            : []),
          ...(input.amountMicros > 0 && !legacyLot ? [{
            sql: "DELETE FROM wallet_allocation_guards WHERE id = ?",
            params: [moneyGuard],
          }] : []),
        ]);
      } catch (error) {
        const committed = await source(input.sourceType, input.sourceId);
        if (committed && sameGrant(committed, input)) return;
        throw error;
      }
    },
    async freezeFunding(organizationId: string, fundingRef: string): Promise<number> {
      if (!organizationId || !fundingRef) fail("invalid_grant");
      const now = at();
      const claimed = await sql.run(
        `INSERT INTO stripe_billing_fences (org_id, funding_ref, generation, active, updated_at)
         VALUES (?, ?, 1, 1, ?)
         ON CONFLICT (org_id, funding_ref) DO UPDATE SET
           generation = generation + 1, active = 1, updated_at = excluded.updated_at
         RETURNING generation`,
        [organizationId, fundingRef, now],
      );
      const generation = Number(claimed.rows[0]?.generation);
      if (claimed.rows.length !== 1 || !Number.isSafeInteger(generation) || generation < 1)
        fail("freeze_unavailable");
      return generation;
    },
    async unfreezeFunding(input: {
      readonly organizationId: string;
      readonly fundingRef: string;
      readonly fenceGeneration: number;
      readonly cumulativeRefundedMicros: number;
    }): Promise<void> {
      const { organizationId, fundingRef, fenceGeneration, cumulativeRefundedMicros } = input;
      positive(fenceGeneration);
      if (
        !organizationId ||
        !fundingRef ||
        !Number.isSafeInteger(cumulativeRefundedMicros) ||
        cumulativeRefundedMicros < 0
      )
        fail("invalid_refund");
      const fence = (
        await sql.query(
          "SELECT generation, active FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ?",
          [organizationId, fundingRef],
        )
      )[0];
      if (!fence || Number(fence.generation) !== fenceGeneration) fail("freeze_changed");
      const refunded = (
        await sql.query(
          "SELECT COALESCE(SUM(amount_micros), 0) AS amount FROM stripe_billing_refunds WHERE org_id = ? AND funding_ref = ?",
          [organizationId, fundingRef],
        )
      )[0];
      if (Number(refunded?.amount ?? 0) !== cumulativeRefundedMicros) fail("refund_out_of_order");
      if (Number(fence.active) === 0) return;
      const check = `guard_${crypto.randomUUID()}`;
      const changed = `${check}_changed`;
      try {
        await sql.batch([
          guard(
            check,
            `EXISTS (SELECT 1 FROM stripe_billing_fences
                 WHERE org_id = ? AND funding_ref = ? AND generation = ? AND active = 1)
                 AND (SELECT COALESCE(SUM(amount_micros), 0) FROM stripe_billing_refunds
                      WHERE org_id = ? AND funding_ref = ?) = ?`,
            [
              organizationId,
              fundingRef,
              fenceGeneration,
              organizationId,
              fundingRef,
              cumulativeRefundedMicros,
            ],
          ),
          {
            sql: `UPDATE stripe_billing_fences SET active = 0, updated_at = ?
                  WHERE org_id = ? AND funding_ref = ? AND generation = ? AND active = 1`,
            params: [at(), organizationId, fundingRef, fenceGeneration],
          },
          guard(changed, "changes() = 1"),
          {
            sql: "DELETE FROM wallet_allocation_guards WHERE id IN (?, ?)",
            params: [check, changed],
          },
        ]);
      } catch (error) {
        const committed = (
          await sql.query(
            "SELECT generation, active FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ?",
            [organizationId, fundingRef],
          )
        )[0];
        const sum = (
          await sql.query(
            "SELECT COALESCE(SUM(amount_micros), 0) AS amount FROM stripe_billing_refunds WHERE org_id = ? AND funding_ref = ?",
            [organizationId, fundingRef],
          )
        )[0];
        if (
          committed &&
          Number(committed.generation) === fenceGeneration &&
          Number(committed.active) === 0 &&
          Number(sum?.amount ?? 0) === cumulativeRefundedMicros
        )
          return;
        throw error;
      }
    },
    async refund(input: {
      readonly refundId: string;
      readonly grant: BillingGrant;
      readonly amountMicros: number;
      readonly cumulativeRefundedMicros: number;
      readonly fenceGeneration: number;
      readonly releaseFreeze?: boolean;
    }): Promise<RefundReceipt> {
      const {
        grant: expected,
        refundId,
        amountMicros,
        cumulativeRefundedMicros,
        fenceGeneration,
      } = input;
      positive(amountMicros);
      positive(cumulativeRefundedMicros);
      positive(fenceGeneration);
      if (!refundId || cumulativeRefundedMicros > expected.considerationMicros)
        fail("invalid_refund");
      const current = await source(expected.sourceType, expected.sourceId);
      if (!current || !sameGrant(current, expected)) fail("grant_conflict");
      const prior = await receipt(refundId);
      if (prior) {
        if (
          prior.organizationId !== expected.organizationId ||
          prior.fundingRef !== expected.fundingRef ||
          prior.amountMicros !== amountMicros ||
          prior.cumulativeRefundedMicros !== cumulativeRefundedMicros
        )
          fail("refund_conflict");
        await clearFenceIfRequested();
        return prior;
      }
      const priorRows = await sql.query(
        `SELECT COALESCE(SUM(amount_micros), 0) AS refunded,
                COALESCE(MAX(target_revoked_micros), 0) AS target,
                COALESCE(SUM(debit_micros), 0) AS debited,
                COALESCE(SUM(expired_micros), 0) AS expired
         FROM stripe_billing_refunds WHERE org_id = ? AND funding_ref = ?`,
        [expected.organizationId, expected.fundingRef],
      );
      const previousRefunded = Number(priorRows[0]?.refunded ?? 0);
      const previousTarget = Number(priorRows[0]?.target ?? 0);
      const previousDebit = Number(priorRows[0]?.debited ?? 0);
      const previousExpired = Number(priorRows[0]?.expired ?? 0);
      if (previousRefunded + amountMicros !== cumulativeRefundedMicros) fail("refund_out_of_order");
      const target =
        cumulativeRefundedMicros === expected.considerationMicros
          ? expected.amountMicros
          : Number(
              (BigInt(expected.amountMicros) * BigInt(cumulativeRefundedMicros)) /
                BigInt(expected.considerationMicros),
            );
      const delta = target - previousTarget;
      if (!Number.isSafeInteger(delta) || delta < 0) fail("refund_conflict");
      const now = at();
      const org = expected.organizationId;
      const ref = expected.fundingRef;
      const heldRefs = await sql.query(
        "SELECT DISTINCT debit_ref FROM wallet_credit_allocations WHERE org_id = ? AND lot_ref = ? AND debit_type = 'hold'",
        [org, ref],
      );
      const closures: SqlStatement[] = [];
      const closureGuards: string[] = [];
      for (const item of heldRefs) {
        const holdRef = String(item.debit_ref);
        const state = (
          await sql.query("SELECT * FROM org_wallet_holds WHERE org_id = ? AND ledger_ref = ?", [
            org,
            holdRef,
          ])
        )[0];
        if (state && (state.state !== "live" || state.money_policy !== "usd-micros-v2"))
          fail("hold_conflict");
        const totals = (
          await sql.query(
            `SELECT (SELECT COALESCE(SUM(amount_micros), 0) FROM wallet_credit_allocations
                   WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?) AS allocated,
                  (SELECT COALESCE(SUM(held_delta_micros), 0) FROM ledger WHERE org_id = ? AND ref = ?) AS held`,
            [org, holdRef, org, holdRef],
          )
        )[0];
        const held = Number(totals?.held ?? 0);
        if (held <= 0 || held !== Number(totals?.allocated)) fail("hold_conflict");
        if (state) {
          closures.push({
            sql: `UPDATE org_wallet_holds SET state = 'released', released_micros = amount_micros,
                    closed_at = ?, closure_reason = 'refund' WHERE org_id = ? AND ledger_ref = ? AND state = 'live'
                    AND money_policy = 'usd-micros-v2'`,
            params: [now, org, holdRef],
          });
          const stateGuard = `guard_${crypto.randomUUID()}`;
          closureGuards.push(stateGuard);
          closures.push(guard(stateGuard, "changes() = 1"));
        }
        const balanceGuard = `guard_${crypto.randomUUID()}`;
        closureGuards.push(balanceGuard);
        closures.push(
          guard(
            balanceGuard,
            `(SELECT COALESCE(SUM(amount_micros), 0) FROM wallet_credit_allocations
            WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?) = ?
           AND (SELECT COALESCE(SUM(held_delta_micros), 0) FROM ledger WHERE org_id = ? AND ref = ?) = ?`,
            [org, holdRef, held, org, holdRef, held],
          ),
        );
        closures.push({
          sql: "DELETE FROM wallet_credit_allocations WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?",
          params: [org, holdRef],
        });
        closures.push({
          sql: `INSERT INTO ledger (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at)
                VALUES (?, ?, 'release', ?, 0, ?, ?)`,
          params: [`led_${crypto.randomUUID()}`, org, holdRef, -held, now],
        });
      }
      const lotRows = await sql.query(
        `SELECT l.amount_micros, l.expires_at,
                COALESCE(SUM(CASE WHEN a.debit_type IN ('capture', 'usage_debit') THEN a.amount_micros ELSE 0 END), 0) AS spent
         FROM wallet_credit_lots l LEFT JOIN wallet_credit_allocations a
           ON a.org_id = l.org_id AND a.lot_ref = l.ref
         WHERE l.org_id = ? AND l.ref = ? GROUP BY l.org_id, l.ref`,
        [org, ref],
      );
      const lot = lotRows[0];
      if (expected.amountMicros > 0 && (!lot || Number(lot.amount_micros) !== expected.amountMicros))
        fail("grant_conflict");
      if (expected.amountMicros === 0 && lot) fail("grant_conflict");
      const spent = Number(lot?.spent ?? 0);
      const unspent = expected.amountMicros - spent - previousDebit - previousExpired;
      if (!Number.isSafeInteger(unspent) || unspent < 0) fail("conservation_violated");
      const unused = Math.min(delta, unspent);
      const expired = lot?.expires_at != null && String(lot.expires_at) <= now ? unused : 0;
      const debit = unused - expired;
      const receivable = delta - unused;
      const fenceId = `guard_${crypto.randomUUID()}`;
      const consistencyId = `guard_${crypto.randomUUID()}`;
      try {
        await sql.batch([
          guard(
            fenceId,
            `EXISTS (SELECT 1 FROM stripe_billing_fences
                     WHERE org_id = ? AND funding_ref = ? AND generation = ? AND active = 1)
                     AND (SELECT COALESCE(SUM(amount_micros), 0) FROM stripe_billing_refunds
                          WHERE org_id = ? AND funding_ref = ?) = ?
                     AND (SELECT COALESCE(MAX(target_revoked_micros), 0) FROM stripe_billing_refunds
                          WHERE org_id = ? AND funding_ref = ?) = ?`,
            [org, ref, fenceGeneration, org, ref, previousRefunded, org, ref, previousTarget],
          ),
          ...closures,
          guard(
            consistencyId,
            `NOT EXISTS (SELECT 1 FROM wallet_credit_allocations
                  WHERE org_id = ? AND lot_ref = ? AND debit_type = 'hold')
                  AND (SELECT COALESCE(SUM(amount_micros), 0) FROM wallet_credit_allocations
                       WHERE org_id = ? AND lot_ref = ? AND debit_type IN ('capture', 'usage_debit')) = ?`,
            [org, ref, org, ref, spent],
          ),
          {
            sql: `INSERT INTO stripe_billing_refunds
              (refund_id, org_id, funding_ref, amount_micros, cumulative_refunded_micros,
               target_revoked_micros, debit_micros, receivable_micros, expired_micros, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              refundId,
              org,
              ref,
              amountMicros,
              cumulativeRefundedMicros,
              target,
              debit,
              receivable,
              expired,
              now,
            ],
          },
          ...(input.releaseFreeze === false
            ? []
            : [
                {
                  sql: "UPDATE stripe_billing_fences SET active = 0, updated_at = ? WHERE org_id = ? AND funding_ref = ? AND generation = ? AND active = 1",
                  params: [now, org, ref, fenceGeneration],
                },
              ]),
          {
            sql: `DELETE FROM wallet_allocation_guards WHERE id IN (${[fenceId, consistencyId, ...closureGuards].map(() => "?").join(", ")})`,
            params: [fenceId, consistencyId, ...closureGuards],
          },
        ]);
      } catch (error) {
        const committed = await receipt(refundId);
        if (
          committed &&
          committed.organizationId === org &&
          committed.fundingRef === ref &&
          committed.amountMicros === amountMicros &&
          committed.cumulativeRefundedMicros === cumulativeRefundedMicros
        ) {
          await clearFenceIfRequested();
          return committed;
        }
        throw error;
      }
      const committed = await receipt(refundId);
      if (!committed) fail("refund_unavailable");
      return committed;

      async function clearFenceIfRequested(): Promise<void> {
        if (input.releaseFreeze === false) return;
        const currentFence = await sql.query(
          "SELECT generation, active FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ?",
          [expected.organizationId, expected.fundingRef],
        );
        // A lost acknowledgement may follow a committed batch which already
        // removed this generation. Never clear a newer worker's freeze.
        if (currentFence.length === 0) fail("freeze_changed");
        if (Number(currentFence[0]?.generation) !== fenceGeneration) fail("freeze_changed");
        if (Number(currentFence[0]?.active) === 0) return;
        const result = await sql.run(
          `UPDATE stripe_billing_fences SET active = 0, updated_at = ?
            WHERE org_id = ? AND funding_ref = ? AND generation = ? AND active = 1`,
          [at(), expected.organizationId, expected.fundingRef, fenceGeneration],
        );
        if (result.changes !== 1) fail("freeze_changed");
      }
    },
  };
}
