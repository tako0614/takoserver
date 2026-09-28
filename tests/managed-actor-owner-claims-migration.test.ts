import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";

const MIGRATION = "0064_cloudflare_managed_actor_owner_claims.sql";
const OWNER = ["provider-a", "installation-a", "account-a", "dispatch-a", "tenant-a", "actor-a"];
const SCRIPT = "tsr-actor-owner-a";
const CLASS = "TakoserverActorOwner";
const DIGEST = "a".repeat(64);
const NAMESPACE = "b".repeat(32);

function insert(database: Database, owner = OWNER, script = SCRIPT) {
  return database
    .query(`INSERT INTO cloudflare_managed_actor_owner_claims
    (provider_id, installation_id, account_id, dispatch_namespace, tenant_id,
     actor_namespace_uid, script_name, owner_class, module_sha256, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed')`)
    .run(...owner, script, CLASS, DIGEST);
}

test("0064 adds an independent consume-once Actor owner claim without widening Worker receipts", () => {
  const database = new Database(":memory:");
  const preceding = MIGRATIONS.filter((migration) => migration.name < MIGRATION);
  for (const migration of preceding) database.exec(migration.sql);
  const before = database
    .query("SELECT sql FROM sqlite_schema WHERE name = 'cloudflare_managed_worker_receipts'")
    .get();
  expect(before).not.toBeNull();
  database
    .query(`INSERT INTO cloudflare_managed_worker_receipts
    (provider_id, resource_uid, native_id, kind, logical_worker_id, operation_id,
     generation, descriptor_digest, state)
    VALUES ('provider-a', 'worker-a', 'worker:worker-a', 'worker', 'worker-a',
      'create-worker-a', 1, 'sha256:${DIGEST}', 'pending')`)
    .run();
  const oldRow = database.query("SELECT * FROM cloudflare_managed_worker_receipts").get();
  const migration = MIGRATIONS.find((item) => item.name === MIGRATION);
  if (migration === undefined) throw new Error(`missing ${MIGRATION}`);
  database.exec(migration.sql);
  expect(
    database
      .query("SELECT sql FROM sqlite_schema WHERE name = 'cloudflare_managed_worker_receipts'")
      .get(),
  ).toEqual(before);
  expect(database.query("SELECT * FROM cloudflare_managed_worker_receipts").get()).toEqual(oldRow);
  expect(() =>
    database
      .query(`INSERT INTO cloudflare_managed_worker_receipts
    (provider_id, resource_uid, native_id, kind, logical_worker_id, operation_id,
     generation, descriptor_digest, state) VALUES
    ('provider-a', 'actor-a', 'actor:actor-a', 'actor', 'actor-a', 'create-a', 1,
     'sha256:${DIGEST}', 'pending')`)
      .run(),
  ).toThrow();

  insert(database);
  expect(() => insert(database)).toThrow();
  expect(() => insert(database, ["provider-b", ...OWNER.slice(1)], SCRIPT)).toThrow();
  expect(() =>
    database.exec("UPDATE cloudflare_managed_actor_owner_claims SET owner_class = 'Other'"),
  ).toThrow();
  expect(() =>
    database.exec(`UPDATE cloudflare_managed_actor_owner_claims
    SET state = 'committed', namespace_id = '${NAMESPACE}', provider_etag = 'etag-a'`),
  ).toThrow();
  database.exec("UPDATE cloudflare_managed_actor_owner_claims SET state = 'upload_authorized'");
  expect(() =>
    database.exec(`UPDATE cloudflare_managed_actor_owner_claims
    SET state = 'committed', namespace_id = '${NAMESPACE}'`),
  ).toThrow();
  database.exec(`UPDATE cloudflare_managed_actor_owner_claims
    SET state = 'committed', namespace_id = '${NAMESPACE}', provider_etag = 'etag-a'`);
  expect(() =>
    database.exec(
      "UPDATE cloudflare_managed_actor_owner_claims SET state = 'claimed', namespace_id = NULL, provider_etag = NULL",
    ),
  ).toThrow();
  expect(() => database.exec("DELETE FROM cloudflare_managed_actor_owner_claims")).toThrow();
  expect(() =>
    insert(database, [...OWNER.slice(0, 5), "actor-b"], "tsr-actor-owner-b"),
  ).not.toThrow();
  database.exec(
    "UPDATE cloudflare_managed_actor_owner_claims SET state = 'upload_authorized' WHERE actor_namespace_uid = 'actor-b'",
  );
  expect(() =>
    database.exec(`UPDATE cloudflare_managed_actor_owner_claims
    SET state = 'committed', namespace_id = '${NAMESPACE}', provider_etag = 'etag-b'
    WHERE actor_namespace_uid = 'actor-b'`),
  ).toThrow();
  database.close();
});

test("0064 is in the forward-only self-host migration lineage", () => {
  const database = new Database(":memory:");
  const report = migrateSqlite(database);
  expect(report.applied).toContain(MIGRATION);
  expect(migrateSqlite(database).applied).toEqual([]);
  database.close();
});
