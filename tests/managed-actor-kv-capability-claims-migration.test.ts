import { Database, type SQLQueryBindings } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";

const MIGRATION = "0066_cloudflare_managed_actor_kv_capability_claims.sql";
const INSERT = `INSERT INTO cloudflare_managed_actor_kv_capability_claims
  (provider_id, target_resource_uid, target_generation, target_deployment_id,
   installation_id, account_id, dispatch_namespace, tenant_id, native_id,
   namespace_id, script_name, module_sha256, state)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed')`;
const REPLACE = `INSERT OR REPLACE INTO cloudflare_managed_actor_kv_capability_claims
  (provider_id, target_resource_uid, target_generation, target_deployment_id,
   installation_id, account_id, dispatch_namespace, tenant_id, native_id,
   namespace_id, script_name, module_sha256, state, provider_etag)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const CLAIM_WITH_AUTHORITY = `INSERT OR IGNORE INTO cloudflare_managed_actor_kv_capability_claims
  (provider_id, target_resource_uid, target_generation, target_deployment_id,
   installation_id, account_id, dispatch_namespace, tenant_id, native_id,
   namespace_id, script_name, module_sha256, state, provider_etag)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', NULL WHERE 1 = 1`;
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

function claim(database: Database, values: readonly SQLQueryBindings[] = CLAIM) {
  return database.query(INSERT).run(...values);
}

function replace(
  database: Database,
  values: readonly SQLQueryBindings[],
  state: string,
  etag: string | null,
) {
  return database.query(REPLACE).run(...values, state, etag);
}

function claimWithAuthority(database: Database, values: readonly SQLQueryBindings[]) {
  return database.query(CLAIM_WITH_AUTHORITY).run(...values);
}

test("0066 adds an immutable, one-shot private Actor KV capability claim", () => {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS.filter((item) => item.name < MIGRATION)) {
    database.exec(migration.sql);
  }
  const capabilityMigration = MIGRATIONS.find((item) => item.name === MIGRATION);
  if (capabilityMigration === undefined) throw new Error(`missing ${MIGRATION}`);
  database.exec(capabilityMigration.sql);
  expect(
    database.query("PRAGMA table_list('cloudflare_managed_actor_kv_capability_claims')").get(),
  ).toMatchObject({ wr: 1 });
  const previousWorkerReceiptSql = database
    .query("SELECT sql FROM sqlite_schema WHERE name = 'cloudflare_managed_worker_receipts'")
    .get();
  expect(claim(database).changes).toBe(1);

  expect(claim(database).changes).toBe(0);
  expect(claim(database, [...CLAIM.slice(0, 5), "account-b", ...CLAIM.slice(6)]).changes).toBe(0);
  expect(claim(database, [...CLAIM.slice(0, 2), 8, ...CLAIM.slice(3)]).changes).toBe(0);
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
  expect(claim(database).changes).toBe(0);
  expect(
    database
      .query(
        "SELECT state, module_sha256 FROM cloudflare_managed_actor_kv_capability_claims WHERE target_generation = 7",
      )
      .get(),
  ).toEqual({ state: "revoked", module_sha256: CLAIM[11] });

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

test("0066 prevents OR REPLACE from resetting a claim in every lifecycle state", () => {
  const database = new Database(":memory:");
  database.exec("PRAGMA recursive_triggers = OFF");
  expect(database.query("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 0 });
  for (const migration of MIGRATIONS.filter((item) => item.name < MIGRATION)) {
    database.exec(migration.sql);
  }
  const capabilityMigration = MIGRATIONS.find((item) => item.name === MIGRATION);
  if (capabilityMigration === undefined) throw new Error(`missing ${MIGRATION}`);
  database.exec(capabilityMigration.sql);

  const cases = [
    { suffix: "claimed", generation: 11, state: "claimed", etag: null },
    { suffix: "authorized", generation: 12, state: "upload_authorized", etag: null },
    { suffix: "committed", generation: 13, state: "committed", etag: "etag-committed" },
    { suffix: "revoked", generation: 14, state: "revoked", etag: null },
  ] as const;
  for (const scenario of cases) {
    const values = [
      `provider-${scenario.suffix}`,
      `resource-${scenario.suffix}`,
      scenario.generation,
      `deployment-${scenario.suffix}`,
      `installation-${scenario.suffix}`,
      `account-${scenario.suffix}`,
      `dispatch-${scenario.suffix}`,
      `tenant-${scenario.suffix}`,
      `actor:${scenario.suffix}`,
      `${scenario.generation}`.padStart(32, "a"),
      `script-${scenario.suffix}`,
      CLAIM[11],
    ] as const;
    expect(claimWithAuthority(database, values).changes).toBe(1);
    expect(claimWithAuthority(database, values).changes).toBe(0);
    if (scenario.state === "upload_authorized" || scenario.state === "committed") {
      database
        .query(
          "UPDATE cloudflare_managed_actor_kv_capability_claims SET state = 'upload_authorized' WHERE target_generation = ?",
        )
        .run(scenario.generation);
    }
    if (scenario.state === "committed") {
      database
        .query(
          "UPDATE cloudflare_managed_actor_kv_capability_claims SET state = 'committed', provider_etag = ? WHERE target_generation = ?",
        )
        .run(scenario.etag, scenario.generation);
    }
    if (scenario.state === "revoked") {
      database
        .query(
          "UPDATE cloudflare_managed_actor_kv_capability_claims SET state = 'revoked' WHERE target_generation = ?",
        )
        .run(scenario.generation);
    }

    const changedHash = [...values.slice(0, 11), "f".repeat(64)] as const;
    expect(replace(database, changedHash, "claimed", null).changes).toBe(0);
    const changedIncarnation = [
      `other-provider-${scenario.suffix}`,
      `other-resource-${scenario.suffix}`,
      scenario.generation + 100,
      `other-deployment-${scenario.suffix}`,
      ...values.slice(4),
    ] as const;
    expect(replace(database, changedIncarnation, "claimed", null).changes).toBe(0);
    for (const rowIdAlias of ["rowid", "_rowid_", "oid"] as const) {
      expect(() =>
        database
          .query(
            `INSERT OR REPLACE INTO cloudflare_managed_actor_kv_capability_claims
             (${rowIdAlias}, provider_id, target_resource_uid, target_generation,
              target_deployment_id, installation_id, account_id, dispatch_namespace,
              tenant_id, native_id, namespace_id, script_name, module_sha256, state,
              provider_etag)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', NULL)`,
          )
          .run(...changedIncarnation),
      ).toThrow();
    }
    expect(
      database
        .query(
          `SELECT state, module_sha256, provider_etag
           FROM cloudflare_managed_actor_kv_capability_claims
           WHERE provider_id = ? AND target_resource_uid = ? AND target_generation = ?
             AND target_deployment_id = ?`,
        )
        .get(...values.slice(0, 4)),
    ).toEqual({ state: scenario.state, module_sha256: CLAIM[11], provider_etag: scenario.etag });
    expect(
      database
        .query(
          `SELECT COUNT(*) AS count FROM cloudflare_managed_actor_kv_capability_claims
           WHERE provider_id = ? AND target_resource_uid = ? AND target_generation = ?
             AND target_deployment_id = ?`,
        )
        .get(...changedIncarnation.slice(0, 4)),
    ).toEqual({ count: 0 });
  }
  expect(
    database
      .query("SELECT COUNT(*) AS count FROM cloudflare_managed_actor_kv_capability_claims")
      .get(),
  ).toEqual({ count: 4 });
  database.close();
});

test("0066 is in the forward-only self-host migration lineage", () => {
  const database = new Database(":memory:");
  const report = migrateSqlite(database);
  expect(report.applied).toContain(MIGRATION);
  expect(migrateSqlite(database).applied).toEqual([]);
  database.close();
});
