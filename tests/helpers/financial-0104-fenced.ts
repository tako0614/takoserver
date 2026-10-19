import type { Database } from "bun:sqlite";
import {
  FINANCIAL_0104_C0_FENCE_SCHEMA,
  FINANCIAL_0104_CONSENT_FENCE_SCHEMA,
  FINANCIAL_0104_CUSTOMER_FENCE_SCHEMA,
  FINANCIAL_0104_RECEIVER_FENCE_SCHEMA,
} from "../../src/financial-0104-money-fence.ts";
import { verifyHostedBillingFinancialRealm } from "../../src/hosted-billing-realm.ts";
import {
  createMoneyCutoverSql,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../../src/money-cutover-sql.ts";
import type { Sql } from "../../src/ports.ts";
import { FINANCIAL_SOURCE_GENESIS_DDL } from "../../src/shared-financial-source-genesis-schema.ts";
import type { StripeBillingClient } from "../../src/stripe-billing-client.ts";

/** Upgrades an existing unfenced component fixture to the exact Financial 0104
 * fence shape for the families it installed, plus Root's permit table/guard.
 * Fixture-only: the real 0104 body is FINANCIAL_0104_DDL. */
export function installFinancial0104Fences(
  db: Database,
  families: {
    readonly receiver?: boolean;
    readonly c0?: boolean;
    readonly genesisOverlay?: boolean;
    readonly consent?: boolean;
    readonly customer?: boolean;
  },
): void {
  if (families.genesisOverlay) db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
  const fences = [
    ...(families.receiver ? Object.values(FINANCIAL_0104_RECEIVER_FENCE_SCHEMA) : []),
    ...(families.c0 ? Object.values(FINANCIAL_0104_C0_FENCE_SCHEMA) : []),
    ...(families.consent ? Object.values(FINANCIAL_0104_CONSENT_FENCE_SCHEMA) : []),
    ...(families.customer ? Object.values(FINANCIAL_0104_CUSTOMER_FENCE_SCHEMA) : []),
  ];
  for (const sql of fences) db.exec(sql);
  const permit = db
    .query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='money_cutover_writer_permit'")
    .all();
  if (permit.length === 0) {
    db.exec(MONEY_CUTOVER_PERMIT_DDL);
    db.exec(MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL);
  }
}

/** The actual permit-framed Money writer over a fixture Sql, and a realm
 * capability verified through that same writer. */
export async function financial0104Writer(
  sql: Sql,
  writerEpoch: string,
  client: StripeBillingClient,
  expected: {
    readonly accountId: string;
    readonly billingAuthority: string;
    readonly priceId: string;
  },
) {
  const money = createMoneyCutoverSql(sql, writerEpoch);
  const realm = await verifyHostedBillingFinancialRealm({
    sql: money,
    reader: { client },
    expected: {
      accountId: expected.accountId,
      mode: "test",
      billingAuthority: expected.billingAuthority,
    },
    prices: [{ priceId: expected.priceId, monthlyAmountMinor: 1000 }],
  });
  return { money, realm };
}

export const MONEY_FREEZE_ROW =
  "INSERT INTO money_cutover_freeze VALUES(1,'binding','origin','backup','writer','source')";

/** A batch the Money writer framed: its first statement inserts and its last
 * deletes Root's writer permit. Fixture transports record and fault only the
 * Financial statements inside it and resend the exact frame around them. */
export function permitFramed(statements: readonly { readonly sql: string }[]): boolean {
  return (
    statements.length >= 2 &&
    /^INSERT INTO money_cutover_writer_permit\b/u.test(statements[0]?.sql ?? "") &&
    /^DELETE FROM money_cutover_writer_permit\b/u.test(statements.at(-1)?.sql ?? "")
  );
}

/** Fixture-only raw seeding inside Root's exact permit frame for `epoch`. */
export function inPermitFrame<T extends { readonly sql: string }>(
  epoch: string,
  statements: readonly T[],
): readonly (T | { readonly sql: string; readonly params: readonly string[] })[] {
  return [
    {
      sql: "INSERT INTO money_cutover_writer_permit(singleton,epoch,writer_epoch) VALUES(1,'usd-micros-v2',?)",
      params: [epoch],
    },
    ...statements,
    {
      sql: "DELETE FROM money_cutover_writer_permit WHERE singleton=1 AND epoch='usd-micros-v2' AND writer_epoch=?",
      params: [epoch],
    },
  ];
}

/** The four pre-existing R1 money fences (three R1 tables and the attempt leaf). */
export const FINANCIAL_R1_MONEY_FENCE_NAMES = Object.freeze([
  "financial_action_source_registrations_money_fence",
  "financial_retained_r1_originals_money_fence",
  "financial_retained_r1_receipts_money_fence",
  "financial_r1_preparation_attempts_money_fence",
]);

/** Drops every installed Financial 0104 money fence, leaving the exact unfenced
 * candidate shape (with any rows already written) for refusal/recovery tests.
 * The R1/attempt fences are kept unless `r1` asks for them too. */
export function dropFinancial0104Fences(
  db: Database,
  options: { readonly r1?: boolean } = {},
): void {
  const fences = db
    .query(
      "SELECT name FROM sqlite_schema WHERE type='trigger' AND (name GLOB '*_money_fence' OR name GLOB '*_money_fence_update')",
    )
    .all() as { name: string }[];
  for (const { name } of fences)
    if (options.r1 || !FINANCIAL_R1_MONEY_FENCE_NAMES.includes(name))
      db.exec(`DROP TRIGGER ${name}`);
}

const FENCE_ROWS =
  "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND (name GLOB '*_money_fence' OR name GLOB '*_money_fence_update')";

/** Fixture-only privileged manipulation: lifts every money fence for exactly
 * the duration of `mutate` and restores the exact rows afterwards. Never used
 * underneath a writer path under test. */
export function withMoneyFencesLifted<T>(db: Database, mutate: () => T): T {
  const fences = db.query(FENCE_ROWS).all() as { name: string; sql: string }[];
  for (const { name } of fences) db.exec(`DROP TRIGGER ${name}`);
  try {
    return mutate();
  } finally {
    for (const { sql } of fences) db.exec(sql);
  }
}

/** A fixture setup Sql whose writes run with the money fences lifted. */
export function fenceLiftedSql(db: Database, raw: Sql): Sql {
  async function lifted<T>(write: () => Promise<T>): Promise<T> {
    const fences = db.query(FENCE_ROWS).all() as { name: string; sql: string }[];
    for (const { name } of fences) db.exec(`DROP TRIGGER ${name}`);
    try {
      return await write();
    } finally {
      for (const { sql } of fences) db.exec(sql);
    }
  }
  return {
    query: (sql, params) => raw.query(sql, params),
    run: (sql, params) => lifted(() => raw.run(sql, params)),
    batch: (statements) => lifted(() => raw.batch(statements)),
  };
}
