import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE,
  MONEY_CUTOVER_FREEZE_TABLE,
  MONEY_CUTOVER_PERMIT_TABLE,
  MONEY_CUTOVER_WRITER_EPOCH_PATTERN,
} from "../../src/money-cutover-sql.ts";
import type { Row } from "../../src/ports.ts";
import { frameHostMigrationSql } from "../../src/sqlite-migration-policy.ts";
import {
  hasImmutableStripeModeRealmSchema,
  STRIPE_MODE_REALM_SCHEMA_QUERY,
  STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES,
  STRIPE_REALM_FINANCIAL_HISTORY_QUERY,
  stripeRealmFinancialHistoryTables,
} from "../../src/stripe-mode-realm.ts";
import { preflightError } from "./errors.ts";

/**
 * Financial's two pieces of the staging-only fresh Money-preserved lineage
 * (`v2-0100-money-preserved`, the new Container Host D1).
 *
 * The public storage owner composes ONE sealed import into a D1 its run created
 * and proved empty: the Money-preserved replay, then the test realm claim built
 * here over that replay's own inventory, then the Writer epoch row minted here.
 * The epoch is fresh for the new database: it hashes the database's identity
 * with 32 random bytes, so no earlier epoch, database or production identity can
 * produce it. Nothing here creates storage, reads a provider or writes a D1.
 */
export const FRESH_MONEY_WRITER_EPOCH_CONTRACT = "takoserver.money-fresh-writer-epoch@v1";

const ACCOUNT = /^[0-9a-f]{32}$/u;
const GENERATION = /^[0-9a-f]{32}$/u;
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NONCE = /^[0-9a-f]{64}$/u;
// Production D1 names (original runtime and production fresh init) are never a
// fresh staging target, whatever else the binding claims.
const PRODUCTION_D1_NAME = /^takoserver-(?:runtime(?:$|-)|p-)/u;
const MONEY_CUTOVER_TABLES = [
  MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE,
  MONEY_CUTOVER_FREEZE_TABLE,
  MONEY_CUTOVER_PERMIT_TABLE,
] as const;

/** The new D1 the epoch belongs to, exactly as the storage generation created it. */
export interface FreshMoneyWriterEpochBinding {
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
  readonly generation: string;
}

/** Operator-private record of one minted epoch. The epoch itself is not a secret. */
export interface FreshMoneyWriterEpochRecord {
  readonly kind: typeof FRESH_MONEY_WRITER_EPOCH_CONTRACT;
  readonly binding: FreshMoneyWriterEpochBinding;
  readonly nonce: string;
  readonly bindingDigest: `sha256:${string}`;
  readonly epoch: `sha256:${string}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function closedBinding(value: unknown): FreshMoneyWriterEpochBinding {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !== "accountId,databaseId,databaseName,generation"
  )
    throw preflightError("fresh Money Writer epoch requires the exact new D1 binding");
  const { accountId, databaseId, databaseName, generation } = value as Record<string, unknown>;
  if (
    typeof accountId !== "string" ||
    !ACCOUNT.test(accountId) ||
    typeof databaseId !== "string" ||
    !DATABASE_ID.test(databaseId) ||
    typeof generation !== "string" ||
    !GENERATION.test(generation) ||
    typeof databaseName !== "string" ||
    PRODUCTION_D1_NAME.test(databaseName) ||
    (databaseName !== `integration-takoserver-${generation}` &&
      databaseName !== `integration-ts-${generation}`)
  )
    throw preflightError("fresh Money Writer epoch requires a generated staging D1 identity");
  return Object.freeze({ accountId, databaseId, databaseName, generation });
}

function bindingDigestOf(binding: FreshMoneyWriterEpochBinding): `sha256:${string}` {
  return sha256(
    JSON.stringify([
      `${FRESH_MONEY_WRITER_EPOCH_CONTRACT}#binding`,
      binding.accountId,
      binding.databaseId,
      binding.databaseName,
      binding.generation,
    ]),
  );
}

function epochOf(bindingDigest: string, nonce: string): `sha256:${string}` {
  return sha256(JSON.stringify([FRESH_MONEY_WRITER_EPOCH_CONTRACT, bindingDigest, nonce]));
}

/**
 * Mints the Writer epoch of one new D1. Each call draws a new nonce, so two
 * mints never return the same epoch, even for the same database. Persist the
 * returned record once; it is the only input the verifier accepts.
 */
export function mintFreshMoneyWriterEpoch(binding: unknown): FreshMoneyWriterEpochRecord {
  const exact = closedBinding(binding);
  const nonce = randomBytes(32).toString("hex");
  const bindingDigest = bindingDigestOf(exact);
  return Object.freeze({
    kind: FRESH_MONEY_WRITER_EPOCH_CONTRACT,
    binding: exact,
    nonce,
    bindingDigest,
    epoch: epochOf(bindingDigest, nonce),
  });
}

/**
 * Pure check that a retained record is an original mint for exactly this new
 * D1 and names this epoch. A target binds the database it serves and its
 * `moneyCutoverWriterEpoch`; both must match the record. With `readbackRows`
 * (all rows of money_cutover_authorized_epoch) the D1 must hold exactly that
 * one epoch row. Throws a preflight error on any difference.
 */
export function verifyFreshMoneyWriterEpoch(
  record: unknown,
  expected: {
    readonly binding: FreshMoneyWriterEpochBinding;
    readonly epoch: string;
    readonly readbackRows?: readonly Row[];
  },
): void {
  if (
    record === null ||
    typeof record !== "object" ||
    Object.keys(record).sort().join() !== "binding,bindingDigest,epoch,kind,nonce"
  )
    throw preflightError("fresh Money Writer epoch record is not the original shape");
  const { kind, binding, nonce, bindingDigest, epoch } = record as Record<string, unknown>;
  const recorded = closedBinding(binding);
  const target = closedBinding(expected.binding);
  if (
    kind !== FRESH_MONEY_WRITER_EPOCH_CONTRACT ||
    typeof nonce !== "string" ||
    !NONCE.test(nonce) ||
    typeof epoch !== "string" ||
    !MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(epoch) ||
    bindingDigest !== bindingDigestOf(recorded) ||
    epoch !== epochOf(bindingDigestOf(recorded), nonce)
  )
    throw preflightError("fresh Money Writer epoch record does not reproduce its epoch");
  if (bindingDigestOf(target) !== bindingDigest || expected.epoch !== epoch)
    throw preflightError("fresh Money Writer epoch belongs to another D1 or target epoch");
  if (expected.readbackRows !== undefined) {
    const rows = expected.readbackRows;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      Object.keys(row).sort().join() !== "singleton,writer_epoch" ||
      row.singleton !== 1 ||
      row.writer_epoch !== epoch
    )
      throw preflightError("fresh Money Writer epoch is not the D1's only authorized epoch");
  }
}

/**
 * The statements the import appends after the realm claim: the single epoch
 * row, then a check that fails the import unless that row is the only one.
 * The claim requires every financial table empty, so this must come after it.
 */
export function freshMoneyWriterEpochSql(record: FreshMoneyWriterEpochRecord): string {
  verifyFreshMoneyWriterEpoch(record, { binding: record.binding, epoch: record.epoch });
  return (
    `INSERT INTO ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE} (singleton, writer_epoch) VALUES (1, '${record.epoch}');\n` +
    `SELECT CASE WHEN (SELECT COUNT(*) FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE}) = 1 AND ` +
    `(SELECT writer_epoch FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE} WHERE singleton = 1) = '${record.epoch}' ` +
    `AND NOT EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_FREEZE_TABLE}) AND NOT EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_PERMIT_TABLE}) ` +
    "THEN 1 ELSE json('fresh Money Writer epoch refused') END AS epoch_bound;"
  );
}

/**
 * The test realm claim over the Money-preserved replay's own inventory. The
 * plain claim cannot be reused: this replay adds the three money_cutover tables,
 * so its financial-history inventory differs. The inventory is taken from
 * `sqlBeforeClaim` executed in memory, and the claim inserts only when no pin
 * exists, the live inventory equals it and every one of those tables is empty;
 * the statement after it fails the import unless exactly the test pin exists.
 */
export function buildFreshPreservedRealmClaim(sqlBeforeClaim: string): {
  readonly sql: string;
  readonly historyTables: readonly string[];
} {
  const database = new Database(":memory:");
  let historyTables: readonly string[];
  try {
    for (const statement of frameHostMigrationSql(sqlBeforeClaim)) database.exec(statement);
    if (
      !hasImmutableStripeModeRealmSchema(
        database.query(STRIPE_MODE_REALM_SCHEMA_QUERY).all() as Row[],
      )
    )
      throw preflightError("fresh preserved realm claim requires the immutable 0098 realm schema");
    historyTables = stripeRealmFinancialHistoryTables(
      database.query(STRIPE_REALM_FINANCIAL_HISTORY_QUERY).all() as Row[],
    );
  } finally {
    database.close();
  }
  const present = new Set(historyTables);
  if (
    STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES.some((table) => !present.has(table)) ||
    MONEY_CUTOVER_TABLES.some((table) => !present.has(table))
  )
    throw preflightError(
      "fresh preserved realm claim requires the complete Money-preserved history schema",
    );
  const empty = historyTables.map((table) => `NOT EXISTS (SELECT 1 FROM "${table}" LIMIT 1)`);
  const sql =
    "INSERT INTO stripe_mode_realm (singleton, mode, pinned_at)\n" +
    "SELECT 1, 'test', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\n" +
    "WHERE NOT EXISTS (SELECT 1 FROM stripe_mode_realm)\n" +
    // json_group_array keeps the ORDER BY name of the inventory query.
    `  AND (SELECT json_group_array(name) FROM (${STRIPE_REALM_FINANCIAL_HISTORY_QUERY})) = '${JSON.stringify(historyTables)}'\n` +
    `  AND ${empty.join("\n  AND ")};\n` +
    "SELECT CASE WHEN (SELECT COUNT(*) FROM stripe_mode_realm) = 1 AND " +
    "(SELECT mode FROM stripe_mode_realm WHERE singleton = 1) = 'test' " +
    "THEN 1 ELSE json('fresh preserved Stripe realm claim refused') END AS claimed;";
  return Object.freeze({ sql, historyTables: Object.freeze([...historyTables]) });
}
