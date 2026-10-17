import { canonicalDigest, canonicalJson } from "./json.ts";
import type { Clock, Row, Sql } from "./ports.ts";
import type { StripeBillingClient } from "./stripe-billing-client.ts";

const ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,250}$/u;
const AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PRICE_ID = /^price_[A-Za-z0-9_]{1,249}$/u;

export type HostedBillingRealmErrorCode =
  | "invalid_configuration"
  | "unsafe_schema"
  | "realm_unbound"
  | "realm_mismatch"
  | "invalid_processor_proof"
  | "financial_history_present"
  | "unqualified_realm"
  | "unavailable";

export class HostedBillingRealmError extends Error {
  constructor(readonly code: HostedBillingRealmErrorCode) {
    super(code);
    this.name = "HostedBillingRealmError";
  }
}

function fail(code: HostedBillingRealmErrorCode): never {
  throw new HostedBillingRealmError(code);
}

/** The explicit deployment selection, never inferred from a secret prefix. */
export interface HostedBillingRealmSelection {
  readonly accountId: string;
  readonly mode: "test";
  readonly billingAuthority: string;
}

/**
 * The captured client itself retrieves GET /v1/account without an account
 * selector or Stripe-Account header. An independent account callback cannot
 * prove its authentication matches the payment client. Account has no livemode:
 * configured Prices read by that same client prove the TEST lane.
 */
export interface HostedBillingRealmReadPort {
  readonly client: StripeBillingClient;
}

export interface HostedBillingRealmPriceProof {
  readonly priceId: string;
  readonly monthlyAmountMinor: number;
}

export interface HostedBillingRealmQualification {
  readonly sql: Sql;
  readonly reader: HostedBillingRealmReadPort;
  readonly expected: HostedBillingRealmSelection;
  readonly prices: readonly HostedBillingRealmPriceProof[];
}

declare const realmBrand: unique symbol;

/** Only successful authenticated, read-only qualification can mint this value. */
export interface HostedBillingFinancialRealm extends HostedBillingRealmSelection {
  readonly [realmBrand]: true;
  readonly livemode: false;
  readonly financialRealm: string;
  readonly prices: readonly HostedBillingRealmPriceProof[];
}

const origins = new WeakMap<
  HostedBillingFinancialRealm,
  {
    readonly sql: Sql;
    readonly client: StripeBillingClient;
    readonly billingAuthority: string;
    readonly prices: string;
  }
>();

const ACCOUNT_REALM_SCHEMA = new Map([
  [
    "table:stripe_billing_account_realms",
    `CREATE TABLE stripe_billing_account_realms (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  billing_authority TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(account_id) BETWEEN 6 AND 255 AND substr(account_id, 1, 5) = 'acct_'
         AND substr(account_id, 6) NOT GLOB '*[^A-Za-z0-9]*'),
  CHECK (length(billing_authority) BETWEEN 1 AND 256
         AND billing_authority GLOB '[A-Za-z0-9]*'
         AND billing_authority NOT GLOB '*[^A-Za-z0-9._:-]*'),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
         AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
)`,
  ],
  ...(["no_replace", "no_update", "no_delete"] as const).map((suffix): [string, string] => [
    `trigger:stripe_billing_account_realms_${suffix}`,
    `CREATE TRIGGER stripe_billing_account_realms_${suffix}
BEFORE ${suffix === "no_replace" ? "INSERT" : suffix === "no_update" ? "UPDATE" : "DELETE"} ON stripe_billing_account_realms
${suffix === "no_replace" ? "WHEN EXISTS (SELECT 1 FROM stripe_billing_account_realms)\n" : ""}BEGIN
  SELECT RAISE(ABORT, 'constraint: authenticated Stripe financial realm is immutable');
END`,
  ]),
]);

// Preserve the exact owning 0098 mode schema. No startup or fresh-account bind
// writes its row, weakens its constraints, or infers a historical mode.
const MODE_REALM_SCHEMA = new Map([
  [
    "table:stripe_mode_realm",
    `CREATE TABLE stripe_mode_realm (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  pinned_at TEXT NOT NULL
)`,
  ],
  ...(["update", "delete"] as const).map((operation): [string, string] => [
    `trigger:stripe_mode_realm_no_${operation}`,
    `CREATE TRIGGER stripe_mode_realm_no_${operation} BEFORE ${operation.toUpperCase()} ON stripe_mode_realm
BEGIN
  SELECT RAISE(ABORT, 'Stripe mode realm pin is immutable');
END`,
  ]),
]);

const REALM_SCHEMA_QUERY =
  "SELECT type, name, sql FROM sqlite_schema WHERE (type = 'table' AND name IN ('stripe_mode_realm', 'stripe_billing_account_realms')) OR (type = 'trigger' AND tbl_name IN ('stripe_mode_realm', 'stripe_billing_account_realms')) ORDER BY type, name";

/** All financial history named by the owning 0098 fresh-mode contract. */
export const HOSTED_BILLING_REALM_HISTORY_TABLES = [
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

const FINANCIAL_PREFIXES = [
  "stripe_",
  "wallet_",
  "org_wallet_",
  "money_",
  "usage_",
  "reseller_settlement_",
  "provider_meter_",
  "sponsorship_",
] as const;
const HISTORY_EXCLUSIONS = new Set([
  "stripe_mode_realm",
  "stripe_billing_account_realms",
  // This immutable migration seed is a unit declaration, not financial history.
  "money_unit_policy",
]);
const FINANCIAL_INVENTORY_PREDICATE = `type = 'table' AND (${FINANCIAL_PREFIXES.map(
  (prefix) => `substr(name, 1, ${prefix.length}) = '${prefix}'`,
).join(" OR ")} OR name IN ('ledger', 'quotes', 'reservations', 'idempotency'))
  AND name NOT IN ('stripe_mode_realm', 'stripe_billing_account_realms', 'money_unit_policy')`;

function capture(input: HostedBillingRealmQualification): HostedBillingRealmQualification {
  const selected = input?.expected;
  const client = input?.reader?.client;
  if (
    selected?.mode !== "test" ||
    typeof selected.accountId !== "string" ||
    !ACCOUNT_ID.test(selected.accountId) ||
    typeof selected.billingAuthority !== "string" ||
    !AUTHORITY.test(selected.billingAuthority) ||
    !input.sql ||
    !client ||
    typeof client.get !== "function" ||
    typeof client.authenticAccount !== "function" ||
    !Array.isArray(input.prices) ||
    input.prices.length < 1 ||
    input.prices.length > 100
  )
    fail("invalid_configuration");
  const ids = new Set<string>();
  const prices = input.prices.map((price) => {
    if (
      !price ||
      typeof price.priceId !== "string" ||
      !PRICE_ID.test(price.priceId) ||
      !Number.isSafeInteger(price.monthlyAmountMinor) ||
      price.monthlyAmountMinor <= 0 ||
      ids.has(price.priceId)
    )
      fail("invalid_configuration");
    ids.add(price.priceId);
    return Object.freeze({ priceId: price.priceId, monthlyAmountMinor: price.monthlyAmountMinor });
  });
  return {
    sql: input.sql,
    expected: Object.freeze({
      accountId: selected.accountId,
      mode: "test" as const,
      billingAuthority: selected.billingAuthority,
    }),
    reader: Object.freeze({ client }),
    prices: Object.freeze(prices),
  };
}

function canonicalTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function hasSchema(rows: readonly Row[], expected: ReadonlyMap<string, string>): boolean {
  if (rows.length !== expected.size) return false;
  const seen = new Set<string>();
  return rows.every((row) => {
    const key = `${row.type}:${row.name}`;
    if (seen.has(key) || row.sql !== expected.get(key)) return false;
    seen.add(key);
    return true;
  });
}

async function assertSchemaAndMode(sql: Sql): Promise<void> {
  const rows = await sql.query(REALM_SCHEMA_QUERY);
  if (!hasSchema(rows, new Map([...ACCOUNT_REALM_SCHEMA, ...MODE_REALM_SCHEMA])))
    fail("unsafe_schema");
  const mode = await sql.query("SELECT singleton, mode, pinned_at FROM stripe_mode_realm");
  if (mode.length !== 1 || mode[0]?.singleton !== 1 || !canonicalTime(mode[0]?.pinned_at))
    fail("realm_unbound");
  if (mode[0]?.mode !== "test") fail("realm_mismatch");
}

async function readPin(sql: Sql, expected: HostedBillingRealmSelection): Promise<boolean> {
  const rows = await sql.query(
    "SELECT singleton, account_id, mode, billing_authority, created_at FROM stripe_billing_account_realms",
  );
  if (rows.length === 0) return false;
  if (rows.length !== 1 || rows[0]?.singleton !== 1 || !canonicalTime(rows[0]?.created_at))
    fail("unsafe_schema");
  const row = rows[0];
  if (
    row?.account_id !== expected.accountId ||
    row.mode !== expected.mode ||
    row.billing_authority !== expected.billingAuthority
  )
    fail("realm_mismatch");
  return true;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_processor_proof");
  return value as Record<string, unknown>;
}

async function authenticate(input: HostedBillingRealmQualification): Promise<void> {
  const client = input.reader.client;
  if (typeof client.authenticAccount !== "function") fail("invalid_configuration");
  let account: unknown;
  try {
    account = await client.authenticAccount();
  } catch {
    // Provider messages can contain request credentials or account details.
    fail("unavailable");
  }
  const identity = object(account);
  if (
    identity.object !== "account" ||
    identity.deleted === true ||
    typeof identity.id !== "string" ||
    !ACCOUNT_ID.test(identity.id)
  )
    fail("invalid_processor_proof");
  if (identity.id !== input.expected.accountId) fail("realm_mismatch");
  for (const configured of input.prices) {
    let result: unknown;
    try {
      result = await client.get("prices", configured.priceId);
    } catch {
      fail("unavailable");
    }
    const price = object(result);
    const recurring = object(price.recurring);
    if (
      price.object !== "price" ||
      price.id !== configured.priceId ||
      price.livemode !== false ||
      price.currency !== "usd" ||
      price.type !== "recurring" ||
      price.billing_scheme !== "per_unit" ||
      price.unit_amount !== configured.monthlyAmountMinor ||
      price.transform_quantity != null ||
      price.custom_unit_amount != null ||
      price.tiers != null ||
      price.tiers_mode != null ||
      price.on_behalf_of != null ||
      price.transfer_data != null ||
      price.application != null ||
      price.account != null ||
      recurring.interval !== "month" ||
      recurring.interval_count !== 1 ||
      recurring.usage_type !== "licensed"
    )
      fail("invalid_processor_proof");
  }
}

async function mint(input: HostedBillingRealmQualification): Promise<HostedBillingFinancialRealm> {
  const digest = await canonicalDigest(input.expected);
  const realm = Object.freeze({
    ...input.expected,
    livemode: false as const,
    financialRealm: `realm:${digest.slice("sha256:".length)}`,
    prices: input.prices,
  }) as HostedBillingFinancialRealm;
  origins.set(realm, {
    sql: input.sql,
    client: input.reader.client,
    billingAuthority: input.expected.billingAuthority,
    prices: priceFingerprint(input.prices),
  });
  return realm;
}

/** Startup is read-only. An absent pin is a refusal, even on an empty database. */
export async function verifyHostedBillingFinancialRealm(
  options: HostedBillingRealmQualification,
): Promise<HostedBillingFinancialRealm> {
  const input = capture(options);
  await assertSchemaAndMode(input.sql);
  if (!(await readPin(input.sql, input.expected))) fail("realm_unbound");
  await authenticate(input);
  // Re-read after remote awaits: qualification cannot hide intervening drift.
  await assertSchemaAndMode(input.sql);
  if (!(await readPin(input.sql, input.expected))) fail("realm_unbound");
  return await mint(input);
}

/** Rejects object-shaped stubs, cloned brands and qualification for another lane. */
export function assertHostedBillingFinancialRealm(
  realm: HostedBillingFinancialRealm,
  context: {
    readonly sql: Sql;
    readonly client: StripeBillingClient;
    readonly billingAuthority: string;
    /** Financial composition supplies its complete configured paid-plan set. */
    readonly prices?: readonly HostedBillingRealmPriceProof[];
  },
): void {
  const origin = origins.get(realm);
  if (
    !origin ||
    origin.sql !== context.sql ||
    origin.client !== context.client ||
    origin.billingAuthority !== context.billingAuthority ||
    (context.prices !== undefined && origin.prices !== priceFingerprint(context.prices))
  )
    fail("unqualified_realm");
}

/** Read-only point-in-time persistence check for an already qualified realm. */
export async function assertHostedBillingFinancialRealmPersisted(
  realm: HostedBillingFinancialRealm,
  context: Parameters<typeof assertHostedBillingFinancialRealm>[1],
): Promise<void> {
  const { sql, client, billingAuthority, prices } = context;
  assertHostedBillingFinancialRealm(realm, {
    sql,
    client,
    billingAuthority,
    ...(prices === undefined ? {} : { prices }),
  });
  await assertSchemaAndMode(sql);
  if (!(await readPin(sql, realm))) fail("realm_unbound");
}

function priceFingerprint(prices: readonly HostedBillingRealmPriceProof[]): string {
  return canonicalJson(
    prices
      .map((price) => ({ priceId: price.priceId, monthlyAmountMinor: price.monthlyAmountMinor }))
      .sort((left, right) => left.priceId.localeCompare(right.priceId)),
  );
}

async function historyTables(sql: Sql): Promise<readonly string[]> {
  const rows = await sql.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name");
  const names = new Set(rows.map((row) => String(row.name)));
  if (HOSTED_BILLING_REALM_HISTORY_TABLES.some((name) => !names.has(name))) fail("unsafe_schema");
  const financial = [...names].filter(
    (name) =>
      !HISTORY_EXCLUSIONS.has(name) &&
      (HOSTED_BILLING_REALM_HISTORY_TABLES.some((required) => name === required) ||
        FINANCIAL_PREFIXES.some((prefix) => name.startsWith(prefix))),
  );
  if (financial.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) fail("unsafe_schema");
  return financial.sort();
}

/**
 * Explicit fresh-database bootstrap only, never called by startup. One guarded
 * INSERT tests the complete financial inventory and its empty state atomically.
 * Existing-data binding requires a separately reviewed owning transition; this
 * module deliberately exposes no boolean/manifest shortcut for that authority.
 */
export async function bindFreshHostedBillingRealm(
  options: HostedBillingRealmQualification & { readonly clock: Clock },
): Promise<HostedBillingFinancialRealm> {
  const input = capture(options);
  const createdAt = options.clock().toISOString();
  if (!canonicalTime(createdAt)) fail("invalid_configuration");
  await assertSchemaAndMode(input.sql);
  if (await readPin(input.sql, input.expected))
    return await verifyHostedBillingFinancialRealm(input);
  const tables = await historyTables(input.sql);
  const empty = tables.map((name) => `NOT EXISTS (SELECT 1 FROM ${name} LIMIT 1)`).join(" AND ");
  const observed = await input.sql.query(`SELECT CASE WHEN ${empty} THEN 1 ELSE 0 END AS fresh`);
  if (observed[0]?.fresh !== 1) fail("financial_history_present");
  await authenticate(input);
  await assertSchemaAndMode(input.sql);
  try {
    await input.sql.run(
      `INSERT INTO stripe_billing_account_realms
       (singleton, account_id, mode, billing_authority, created_at)
       SELECT 1, ?, 'test', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM stripe_billing_account_realms)
         AND EXISTS (SELECT 1 FROM stripe_mode_realm WHERE singleton = 1 AND mode = 'test')
         AND (SELECT COUNT(*) FROM sqlite_schema WHERE ${FINANCIAL_INVENTORY_PREDICATE}) = ?
         AND ${empty}`,
      [input.expected.accountId, input.expected.billingAuthority, createdAt, tables.length],
    );
  } catch {
    // A lost acknowledgement can only be settled by this exact immutable pin.
    await assertSchemaAndMode(input.sql);
    if (!(await readPin(input.sql, input.expected))) fail("unavailable");
  }
  await assertSchemaAndMode(input.sql);
  if (!(await readPin(input.sql, input.expected))) fail("financial_history_present");
  return await mint(input);
}
