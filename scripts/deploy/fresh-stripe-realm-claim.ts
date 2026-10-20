import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Row } from "../../src/ports.ts";
import {
  hasImmutableStripeModeRealmSchema,
  STRIPE_MODE_REALM_SCHEMA_QUERY,
  STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES,
  STRIPE_REALM_FINANCIAL_HISTORY_QUERY,
  stripeRealmFinancialHistoryTables,
} from "../../src/stripe-mode-realm.ts";
import { buildD1MigrationImport, type D1MigrationImportArtifact } from "./d1-migration-import.ts";
import { preflightError } from "./errors.ts";
import type { MigrationFile } from "./migrations.ts";

/** The only mode a staging fresh generation claims. */
export const FRESH_STRIPE_REALM_CLAIM_MODE = "test";

export interface FreshStripeRealmClaim {
  readonly mode: typeof FRESH_STRIPE_REALM_CLAIM_MODE;
  /** Every financial-history table the claim requires to be empty, in query order. */
  readonly historyTables: readonly string[];
  readonly sql: string;
}

/**
 * The statements a fresh import appends after its last migration so the 0098
 * Stripe realm is claimed inside the same import that creates the schema.
 *
 * The insert runs only when no pin exists, the financial-history inventory is
 * exactly the one these migrations create, and every one of those tables is
 * empty, the same conditions as `claimFreshStripeModeRealm`. The statement
 * after it fails the import unless exactly the test pin now exists, so an
 * existing pin, a history row or an unexpected financial table refuses the
 * import instead of leaving an unpinned D1. The pin is never inferred from an
 * old database or a Stripe key.
 */
export function buildFreshStripeRealmClaim(files: readonly MigrationFile[]): FreshStripeRealmClaim {
  const database = new Database(":memory:");
  let historyTables: readonly string[];
  try {
    database.exec(buildD1MigrationImport(files, { freshLedger: true }).sql);
    if (
      !hasImmutableStripeModeRealmSchema(
        database.query(STRIPE_MODE_REALM_SCHEMA_QUERY).all() as Row[],
      )
    )
      throw preflightError("fresh Stripe realm claim requires the immutable 0098 realm schema");
    historyTables = stripeRealmFinancialHistoryTables(
      database.query(STRIPE_REALM_FINANCIAL_HISTORY_QUERY).all() as Row[],
    );
  } finally {
    database.close();
  }
  const present = new Set(historyTables);
  if (STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES.some((table) => !present.has(table)))
    throw preflightError("fresh Stripe realm claim requires the complete financial history schema");
  const empty = historyTables.map((table) => `NOT EXISTS (SELECT 1 FROM "${table}" LIMIT 1)`);
  const sql =
    "INSERT INTO stripe_mode_realm (singleton, mode, pinned_at)\n" +
    `SELECT 1, '${FRESH_STRIPE_REALM_CLAIM_MODE}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\n` +
    "WHERE NOT EXISTS (SELECT 1 FROM stripe_mode_realm)\n" +
    // json_group_array follows the subquery's ORDER BY name, as in the runtime
    // claimFreshStripeModeRealm; the expected list comes from the same query.
    `  AND (SELECT json_group_array(name) FROM (${STRIPE_REALM_FINANCIAL_HISTORY_QUERY})) = '${JSON.stringify(historyTables)}'\n` +
    `  AND ${empty.join("\n  AND ")};\n` +
    // json() on a non-JSON literal raises, failing the import unless this very
    // INSERT wrote the row (changes() = 1, so a pre-existing test pin also
    // refuses) and exactly the test pin now exists.
    "SELECT CASE WHEN changes() = 1 AND (SELECT COUNT(*) FROM stripe_mode_realm) = 1 AND " +
    `(SELECT mode FROM stripe_mode_realm WHERE singleton = 1) = '${FRESH_STRIPE_REALM_CLAIM_MODE}' ` +
    "THEN 1 ELSE json('fresh Stripe realm claim refused') END AS claimed;";
  return { mode: FRESH_STRIPE_REALM_CLAIM_MODE, historyTables, sql };
}

/**
 * The one import file of a fresh generation: the unchanged migration import,
 * one newline, then the realm claim. Its digest is what the generation record
 * names, so the claim is part of the sealed original, not a later write.
 */
export function appendFreshStripeRealmClaim(
  migrations: D1MigrationImportArtifact,
  claim: FreshStripeRealmClaim,
): D1MigrationImportArtifact {
  const sql = `${migrations.sql}\n${claim.sql}`;
  const bytes = Buffer.from(sql, "utf8");
  return {
    sql,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.byteLength,
  };
}
