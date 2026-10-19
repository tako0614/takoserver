import type { Database } from "bun:sqlite";
import {
  FINANCIAL_0104_C0_FENCE_SCHEMA,
  FINANCIAL_0104_CONSENT_FENCE_SCHEMA,
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
  },
): void {
  if (families.genesisOverlay) db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
  const fences = [
    ...(families.receiver ? Object.values(FINANCIAL_0104_RECEIVER_FENCE_SCHEMA) : []),
    ...(families.c0 ? Object.values(FINANCIAL_0104_C0_FENCE_SCHEMA) : []),
    ...(families.consent ? Object.values(FINANCIAL_0104_CONSENT_FENCE_SCHEMA) : []),
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
