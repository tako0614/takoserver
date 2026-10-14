import type { Row, Sql } from "./ports.ts";

export type StripeMode = "test" | "live";

export type StripeModeRealmErrorCode =
  | "invalid_mode"
  | "not_pinned"
  | "mode_mismatch"
  | "legacy_history"
  | "unsafe_schema";

export class StripeModeRealmError extends Error {
  constructor(
    readonly code: StripeModeRealmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StripeModeRealmError";
  }
}

/** Undefined is the only absent value; explicit empty or unknown values fail closed. */
export function parseStripeMode(value: unknown): StripeMode {
  if (value === undefined) return "test";
  if (value === "test" || value === "live") return value;
  throw new StripeModeRealmError("invalid_mode", "Stripe mode must be exactly 'test' or 'live'");
}

export const STRIPE_MODE_REALM_SCHEMA_QUERY =
  "SELECT type, name, sql FROM sqlite_schema WHERE (type = 'table' AND name = 'stripe_mode_realm') OR (type = 'trigger' AND tbl_name = 'stripe_mode_realm') ORDER BY type, name";

export type StripeModeRealmSchemaRow = Row;

// The exact SQLite sqlite_schema representation produced by the immutable
// 0098 migration. Tests apply that historical SQL and compare every row, so
// these small runtime constants cannot drift without a failing source check.
const STRIPE_MODE_REALM_SCHEMA = new Map([
  [
    "table:stripe_mode_realm",
    `CREATE TABLE stripe_mode_realm (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  pinned_at TEXT NOT NULL
)`,
  ],
  [
    "trigger:stripe_mode_realm_no_update",
    `CREATE TRIGGER stripe_mode_realm_no_update BEFORE UPDATE ON stripe_mode_realm
BEGIN
  SELECT RAISE(ABORT, 'Stripe mode realm pin is immutable');
END`,
  ],
  [
    "trigger:stripe_mode_realm_no_delete",
    `CREATE TRIGGER stripe_mode_realm_no_delete BEFORE DELETE ON stripe_mode_realm
BEGIN
  SELECT RAISE(ABORT, 'Stripe mode realm pin is immutable');
END`,
  ],
]);

/** Only the canonical table constraints and unconditional triggers are accepted. */
export function hasImmutableStripeModeRealmSchema(
  rows: readonly StripeModeRealmSchemaRow[],
): boolean {
  if (rows.length !== STRIPE_MODE_REALM_SCHEMA.size) return false;
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.type !== "string" || typeof row.name !== "string") return false;
    const key = `${row.type}:${row.name}`;
    if (seen.has(key) || row.sql !== STRIPE_MODE_REALM_SCHEMA.get(key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * Check a previously established deployment-wide Stripe mode without writing.
 * The migration must exist and the single pin must already be present.
 */
async function assertImmutableStripeModeSchema(sql: Sql): Promise<void> {
  if (!hasImmutableStripeModeRealmSchema(await sql.query(STRIPE_MODE_REALM_SCHEMA_QUERY))) {
    throw new StripeModeRealmError(
      "unsafe_schema",
      "Stripe mode realm immutability is unavailable",
    );
  }
}

export async function assertStripeModeRealm(sql: Sql, mode: StripeMode): Promise<void> {
  await assertImmutableStripeModeSchema(sql);
  const rows = await sql.query("SELECT mode FROM stripe_mode_realm WHERE singleton = 1");
  const pinnedMode = rows[0]?.mode;
  if (pinnedMode !== "test" && pinnedMode !== "live") {
    throw new StripeModeRealmError("not_pinned", "Stripe mode realm has not been pinned");
  }
  if (pinnedMode !== mode) {
    throw new StripeModeRealmError(
      "mode_mismatch",
      `Stripe mode realm is pinned to '${pinnedMode}', not '${mode}'`,
    );
  }
}

// These are durable money, wallet, and Stripe facts/configuration whose
// historical realm cannot safely be recovered from Stripe object IDs. Static
// `money_unit_policy` is deliberately excluded: migrations seed it on every
// database and it contains no Stripe or wallet history.
export const STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES = [
  "ledger",
  "quotes",
  "reservations",
  "usage_statements",
  "usage_events",
  "idempotency",
  "wallet_credit_lots",
  "wallet_credit_allocations",
  "wallet_allocation_guards",
  "wallet_credit_lot_classification_proofs",
  "org_wallet_holds",
  "org_wallet_usage_records",
  "org_wallet_grant_snapshots",
  "org_wallet_pricing_revisions",
  "org_wallet_monthly_tariffs",
  "money_cutover_preimage",
  "money_cutover_aggregates",
  "sponsorship_tenants",
  "sponsorship_resources",
  "reseller_settlement_intents",
  "reseller_settlement_guards",
  "provider_meter_checkpoints",
  "provider_meter_schedule",
  "stripe_events",
  "stripe_billing_customers",
  "stripe_billing_subscriptions",
  "stripe_billing_commands",
  "stripe_billing_checkouts",
  "stripe_billing_reconcile",
  "stripe_billing_object_claims",
  "stripe_billing_reconcile_failures",
  "stripe_billing_pricing",
  "stripe_billing_refund_observations",
  "stripe_billing_grants",
  "stripe_billing_fences",
  "stripe_billing_refunds",
  "stripe_billing_price_identity",
  "stripe_billing_price_identity_checks",
  "stripe_subscription_checkout_intents",
  "stripe_subscription_custody_reconcile",
  "stripe_billing_associations",
  "stripe_subscription_cancellation_intents",
] as const;

const FRESH_HISTORY_PREDICATE = STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES.map(
  (table) => `NOT EXISTS (SELECT 1 FROM ${table} LIMIT 1)`,
).join("\n    AND ");

/**
 * Atomically establish the mode only on a fresh source database. Existing
 * Organization/principal rows are permitted; any wallet, usage-money, or
 * Stripe fact/config row makes an absent pin ambiguous and is preserved.
 * Missing tables fail in SQLite/D1 while preparing the statement, never being
 * treated as empty. Old writers are not fenced by this pin and must be drained
 * separately before activation.
 */
export async function claimFreshStripeModeRealm(sql: Sql, mode: StripeMode): Promise<void> {
  await assertImmutableStripeModeSchema(sql);
  await sql.run(
    `INSERT INTO stripe_mode_realm (singleton, mode, pinned_at)
     SELECT 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE ${FRESH_HISTORY_PREDICATE}
     ON CONFLICT(singleton) DO NOTHING`,
    [mode],
  );

  const rows = await sql.query("SELECT mode FROM stripe_mode_realm WHERE singleton = 1");
  if (rows.length === 0) {
    throw new StripeModeRealmError(
      "legacy_history",
      "Cannot pin Stripe mode because existing wallet, money, or Stripe history has no realm",
    );
  }
  await assertStripeModeRealm(sql, mode);
}
