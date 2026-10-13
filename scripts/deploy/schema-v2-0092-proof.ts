import { createHash } from "node:crypto";
import type { RemoteD1 } from "./d1.ts";
import { type DeployPhase, preflightError, verificationError } from "./errors.ts";

const MAX_PROTECTED_ROWS = 1000;
const PROTECTED_TABLES = [
  {
    name: "ledger",
    sql: "SELECT id, org_id, type, ref, CAST(settled_delta AS TEXT) AS settled_delta, CAST(held_delta AS TEXT) AS held_delta, created_at FROM ledger ORDER BY id LIMIT 1001",
  },
  {
    name: "wallet_credit_lots",
    sql: "SELECT org_id, ref, kind, CAST(amount_minor AS TEXT) AS amount_minor, expires_at, created_at FROM wallet_credit_lots ORDER BY org_id, ref LIMIT 1001",
  },
  {
    name: "wallet_credit_allocations",
    sql: "SELECT org_id, debit_type, debit_ref, lot_ref, CAST(amount_minor AS TEXT) AS amount_minor, created_at FROM wallet_credit_allocations ORDER BY org_id, debit_type, debit_ref, lot_ref LIMIT 1001",
  },
] as const;
const NEW_TABLES = [
  "stripe_events",
  "org_wallet_holds",
  "org_wallet_usage_records",
  "org_wallet_grant_snapshots",
  "org_wallet_pricing_revisions",
  "org_wallet_monthly_tariffs",
] as const;

export interface SchemaV20092WalletProof {
  readonly protectedRows: Readonly<Record<string, number>>;
  readonly protectedDigest: string;
  readonly foreignKeyViolations: number;
  readonly invalidCursorCount: number | null;
  readonly newTableRows: Readonly<Record<string, number>> | null;
}

/** A bounded value-free proof of the money rows that 0092 must preserve. */
export async function inspectSchemaV20092WalletProof(
  database: Pick<RemoteD1, "query">,
  phase: DeployPhase,
  appliedCount: 88 | 92,
): Promise<SchemaV20092WalletProof> {
  const hash = createHash("sha256");
  const protectedRows: Record<string, number> = {};
  for (const table of PROTECTED_TABLES) {
    const expectedCount = count(
      await database.query(
        phase,
        `0092 ${table.name} row count`,
        `SELECT COUNT(*) AS rows FROM ${table.name}`,
      ),
      "rows",
      phase,
    );
    if (expectedCount > MAX_PROTECTED_ROWS) {
      throw proofError(
        phase,
        `0092 ${table.name} exceeds the reviewed ${MAX_PROTECTED_ROWS}-row staging proof bound`,
      );
    }
    const rows = await database.query(phase, `0092 ${table.name} preservation`, table.sql);
    if (rows.length !== expectedCount) {
      throw proofError(
        phase,
        `0092 ${table.name} row readback is truncated or changed during the proof`,
      );
    }
    protectedRows[table.name] = rows.length;
    hash.update(table.name);
    hash.update("\0");
    hash.update(JSON.stringify(rows));
    hash.update("\0");
  }
  const foreignKeys = await database.query(
    phase,
    "0092 foreign-key integrity",
    "SELECT COUNT(*) AS violations FROM pragma_foreign_key_check",
  );
  const foreignKeyViolations = count(foreignKeys, "violations", phase);
  let invalidCursorCount: number | null = null;
  let newTableRows: Record<string, number> | null = null;
  if (appliedCount === 92) {
    invalidCursorCount = count(
      await database.query(
        phase,
        "0092 wallet cursor integrity",
        "SELECT COUNT(*) AS violations FROM wallet_credit_lots WHERE cursor_handle IS NULL OR length(cursor_handle) != 32 OR cursor_handle GLOB '*[^0-9a-f]*'",
      ),
      "violations",
      phase,
    );
    newTableRows = {};
    for (const table of NEW_TABLES) {
      newTableRows[table] = count(
        await database.query(
          phase,
          `0092 ${table} empty-state`,
          `SELECT COUNT(*) AS rows FROM ${table}`,
        ),
        "rows",
        phase,
      );
    }
  }
  return {
    protectedRows,
    protectedDigest: `sha256:${hash.digest("hex")}`,
    foreignKeyViolations,
    invalidCursorCount,
    newTableRows,
  };
}

export function assertSchemaV20092PreProof(proof: SchemaV20092WalletProof): void {
  if (
    proof.foreignKeyViolations !== 0 ||
    proof.invalidCursorCount !== null ||
    proof.newTableRows !== null
  ) {
    throw preflightError("0092 predecessor wallet proof is not an intact 0088 state");
  }
}

export function assertSchemaV20092PostProof(
  before: SchemaV20092WalletProof,
  after: SchemaV20092WalletProof,
): void {
  if (
    before.protectedDigest !== after.protectedDigest ||
    JSON.stringify(before.protectedRows) !== JSON.stringify(after.protectedRows) ||
    after.foreignKeyViolations !== 0 ||
    after.invalidCursorCount !== 0 ||
    after.newTableRows === null ||
    Object.values(after.newTableRows).some((value) => value !== 0)
  ) {
    throw verificationError(
      "0092 wallet preservation or new-table postconditions differ; repair forward",
    );
  }
}

function count(
  rows: readonly Record<string, unknown>[],
  field: string,
  phase: DeployPhase,
): number {
  const value = rows.length === 1 ? rows[0]?.[field] : undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw proofError(phase, `0092 proof returned a malformed ${field} count`);
  }
  return value as number;
}

function proofError(phase: DeployPhase, message: string): Error {
  return phase === "verification"
    ? verificationError(`${message}; repair forward`)
    : preflightError(message);
}
