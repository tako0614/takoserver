import { Database } from "bun:sqlite";
import { join } from "node:path";
import { MIGRATIONS } from "../../src/db-schema.ts";
import type { Sql } from "../../src/ports.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { databaseAfter } from "./migrated-database.ts";

export const HOSTED_BILLING_REALM_TEST_INSTANT = "2026-10-15T00:00:00.000Z";

/** Applies owning SQL bytes, never a table manufactured by the verifier. */
export async function hostedBillingRealmTestMigrations(): Promise<readonly string[]> {
  const migrations = MIGRATIONS.filter((migration) => migration.name.slice(0, 4) < "0096").map(
    (migration) => migration.sql,
  );
  const directory =
    process.env.TAKOSERVER_BILLING_CUSTODY_TEST_SCHEMA_DIRECTORY ??
    new URL("../../migrations", import.meta.url).pathname;
  for (const name of [
    "0096_subscription_checkout_custody.sql",
    "0097_subscription_cancellation_custody.sql",
    "0098_stripe_mode_realm.sql",
  ])
    migrations.push(await Bun.file(join(directory, name)).text());
  const extension =
    process.env.TAKOSERVER_BILLING_EXTENSION_TEST_SCHEMA ??
    new URL("../../migrations/0099_hosted_billing_extensions.sql", import.meta.url).pathname;
  migrations.push(await Bun.file(extension).text());
  return migrations;
}

export async function createHostedBillingRealmTestDatabase(
  input: { readonly mode?: "test" | "live" | null } = {},
): Promise<{
  readonly db: Database;
  readonly sql: Sql;
}> {
  const db = databaseAfter(await hostedBillingRealmTestMigrations());
  try {
    const sql = createSqliteSql(db);
    if (input.mode !== null)
      await sql.run("INSERT INTO stripe_mode_realm VALUES (1, ?, ?)", [
        input.mode ?? "test",
        HOSTED_BILLING_REALM_TEST_INSTANT,
      ]);
    return { db, sql };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Fixture setup is explicit; production startup never creates this pin. */
export async function seedHostedBillingRealmTestPin(
  sql: Sql,
  input: { readonly accountId: string; readonly billingAuthority: string },
): Promise<void> {
  await sql.run(
    "INSERT INTO stripe_billing_account_realms (singleton, account_id, mode, billing_authority, created_at) VALUES (1, ?, 'test', ?, ?)",
    [input.accountId, input.billingAuthority, HOSTED_BILLING_REALM_TEST_INSTANT],
  );
}
