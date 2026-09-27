import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";

const MIGRATION = "0066_cloudflare_managed_actor_kv_capability_claims.sql";
const INSERT = `INSERT INTO cloudflare_managed_actor_kv_capability_claims
  (provider_id, target_resource_uid, target_generation, target_deployment_id,
   installation_id, account_id, dispatch_namespace, tenant_id, native_id,
   namespace_id, script_name, module_sha256, state)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed')`;
const CLAIM = [
  "provider-a",
  "resource-a",
  7,
  "deployment-a",
  "installation-a",
  "account-a",
  "dispatch-a",
  "tenant-a",
  "actor:resource-a",
  "b".repeat(32),
  "tsr-actor-kv-a",
  "a".repeat(64),
] as const;

function claim(database: Database, values = CLAIM) {
  return database.query(INSERT).run(...values);
}

test("0066 adds an immutable, one-shot private Actor KV capability claim", () => {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS.filter((item) => item.name < MIGRATION)) {
    database.exec(migration.sql);
  }
  const capabilityMigration = MIGRATIONS.find((item) => item.name === MIGRATION);
  if (capabilityMigration === undefined) throw new Error(`missing ${MIGRATION}`);
  database.exec(capabilityMigration.sql);
  const previousWorkerReceiptSql = database
    .query("SELECT sql FROM sqlite_schema WHERE name = 'cloudflare_managed_worker_receipts'")
    .get();
  claim(database);

  expect(() => claim(database)).toThrow();
  expect(() => claim(database, [...CLAIM.slice(0, 5), "account-b", ...CLAIM.slice(6)])).toThrow();
  expect(() => claim(database, [...CLAIM.slice(0, 2), 8, ...CLAIM.slice(3)])).toThrow();
  const retryIncarnation = [
    ...CLAIM.slice(0, 2),
    8,
    ...CLAIM.slice(3, 5),
    "account-c",
    ...CLAIM.slice(6),
  ] as const;
  claim(database, retryIncarnation);
  expect(() =>
    database.exec(
      "UPDATE cloudflare_managed_actor_kv_capability_claims SET tenant_id = 'other' WHERE target_generation = 7",
    ),
  ).toThrow();
  expect(() =>
    database.exec(
      "UPDATE cloudflare_managed_actor_kv_capability_claims SET state = 'committed' WHERE target_generation = 7",
    ),
  ).toThrow();
  expect(() =>
    database.exec(
      "UPDATE cloudflare_managed_actor_kv_capability_claims SET state = 'revoked' WHERE target_generation = 7",
    ),
  ).not.toThrow();
  expect(() =>
    database.exec("DELETE FROM cloudflare_managed_actor_kv_capability_claims"),
  ).toThrow();
  expect(() => claim(database)).toThrow();

  database.exec(
    "UPDATE cloudflare_managed_actor_kv_capability_claims SET state = 'upload_authorized' WHERE target_generation = 8",
  );
  // An authorized PUT with an unknown outcome cannot be revoked or reissued.
  expect(() =>
    database.exec(
      "UPDATE cloudflare_managed_actor_kv_capability_claims SET state = 'revoked' WHERE target_generation = 8",
    ),
  ).toThrow();
  expect(() =>
    database.exec(
      "UPDATE cloudflare_managed_actor_kv_capability_claims SET state = 'committed' WHERE target_generation = 8",
    ),
  ).toThrow();
  database.exec(
    "UPDATE cloudflare_managed_actor_kv_capability_claims SET state = 'committed', provider_etag = 'etag-a' WHERE target_generation = 8",
  );
  expect(() =>
    database.exec(
      "UPDATE cloudflare_managed_actor_kv_capability_claims SET provider_etag = 'etag-b' WHERE target_generation = 8",
    ),
  ).toThrow();
  expect(() =>
    database.exec(
      "UPDATE cloudflare_managed_actor_kv_capability_claims SET state = 'claimed', provider_etag = NULL WHERE target_generation = 8",
    ),
  ).toThrow();
  expect(
    database
      .query("SELECT sql FROM sqlite_schema WHERE name = 'cloudflare_managed_worker_receipts'")
      .get(),
  ).toEqual(previousWorkerReceiptSql);
  database.close();
});

test("0066 is in the forward-only self-host migration lineage", () => {
  const database = new Database(":memory:");
  const report = migrateSqlite(database);
  expect(report.applied).toContain(MIGRATION);
  expect(migrateSqlite(database).applied).toEqual([]);
  database.close();
});
