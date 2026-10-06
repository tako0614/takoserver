import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformStore } from "../src/takoform/store.ts";

const HOSTNAME = "ce-1234567890abcdef1234567890abcdef12345678.container.test";
const HOSTNAME_INDEX_MIGRATION = "0067_takoform_container_endpoint_hostname_index.sql";
const INVOCATION_CUSTODY_MIGRATION = "0068_cloudflare_provider_invocation_custody.sql";
const INVOCATION_DELETE_ACK_MIGRATION = "0069_cloudflare_provider_invocation_delete_ack.sql";
const TAKOFORM_V2_MIGRATION = "0070_takoform_v2.sql";
const V2_MIGRATION_SET_CUSTODY = "0071_v2_sqlite_migration_set_custody.sql";

function insertResource(
  database: Database,
  input: {
    tenant: string;
    name: string;
    kind: string;
    hostname?: string;
  },
): void {
  const resourceJson = JSON.stringify({
    metadata: { uid: `uid_${input.tenant}_${input.name}` },
    status: { outputs: { hostname: input.hostname ?? "unrelated.container.test" } },
  });
  database
    .query(
      `INSERT INTO tf_resources
         (tenant_id, space, api_version, kind, name, uid, generation, revision,
          resource_json, relations_json, updated_at)
       VALUES (?, 'main', 'edge.forms.takoform.com', ?, ?, ?, '1', 'rev-1', ?, '[]', 100)`,
    )
    .run(input.tenant, input.kind, input.name, `uid_${input.tenant}_${input.name}`, resourceJson);
}

test("committed ContainerEndpoint hostname lookup uses an index and keeps duplicate detection", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    insertResource(database, {
      tenant: "tenant_one",
      name: "web",
      kind: "ContainerEndpoint",
      hostname: HOSTNAME,
    });
    insertResource(database, {
      tenant: "tenant_other",
      name: "worker",
      kind: "ModuleWorker",
      hostname: HOSTNAME,
    });

    const underlying = createSqliteSql(database);
    let lookupSql: string | undefined;
    const intercepted: Sql = {
      ...underlying,
      async query(statement, params) {
        if (
          statement.includes("FROM tf_resources") &&
          statement.includes("status.outputs.hostname")
        ) {
          lookupSql = statement;
        }
        return await underlying.query(statement, params);
      },
    };
    const store = createTakoformStore(intercepted, () => new Date(100));
    expect((await store.containerEndpointByHostname(HOSTNAME))?.listing.uid).toBe(
      "uid_tenant_one_web",
    );
    expect(await store.containerEndpointByHostname("missing.container.test")).toBeNull();
    if (!lookupSql) throw new Error("ContainerEndpoint lookup SQL was not captured");
    const plan = database.query(`EXPLAIN QUERY PLAN ${lookupSql}`).all(HOSTNAME) as {
      detail: string;
    }[];
    expect(
      plan.some((step) =>
        step.detail.includes("USING INDEX tf_resources_container_endpoint_hostname"),
      ),
    ).toBe(true);

    insertResource(database, {
      tenant: "tenant_two",
      name: "web",
      kind: "ContainerEndpoint",
      hostname: HOSTNAME,
    });
    await expect(store.containerEndpointByHostname(HOSTNAME)).rejects.toThrow(
      "ambiguous_container_endpoint_hostname",
    );
    database
      .query("DELETE FROM tf_resources WHERE tenant_id = 'tenant_two' AND name = 'web'")
      .run();
    expect((await store.containerEndpointByHostname(HOSTNAME))?.listing.uid).toBe(
      "uid_tenant_one_web",
    );
    database
      .query(
        "UPDATE tf_resources SET resource_json = ? WHERE tenant_id = 'tenant_one' AND name = 'web'",
      )
      .run(JSON.stringify({ status: { outputs: { hostname: "new.container.test" } } }));
    expect(await store.containerEndpointByHostname(HOSTNAME)).toBeNull();
    expect((await store.containerEndpointByHostname("new.container.test"))?.listing.uid).toBe(
      "uid_tenant_one_web",
    );
    database
      .query("DELETE FROM tf_resources WHERE tenant_id = 'tenant_one' AND name = 'web'")
      .run();
    expect(await store.containerEndpointByHostname("new.container.test")).toBeNull();
  } finally {
    database.close();
  }
});

test("0067 upgrades nonempty 0066 Resource data without changing rows", async () => {
  const database = new Database(":memory:");
  try {
    database.exec(`CREATE TABLE applied_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const next = MIGRATIONS.findIndex((migration) => migration.name === HOSTNAME_INDEX_MIGRATION);
    expect(next).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, next)) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migration.sql);
        database
          .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'fixture')")
          .run(migration.name);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    insertResource(database, {
      tenant: "tenant_existing",
      name: "web",
      kind: "ContainerEndpoint",
      hostname: HOSTNAME,
    });
    insertResource(database, {
      tenant: "tenant_existing",
      name: "worker",
      kind: "ModuleWorker",
      hostname: HOSTNAME,
    });
    const before = database.query("SELECT * FROM tf_resources ORDER BY kind").all();
    const report = migrateSqlite(database);
    expect(report.applied).toEqual([
      HOSTNAME_INDEX_MIGRATION,
      INVOCATION_CUSTODY_MIGRATION,
      INVOCATION_DELETE_ACK_MIGRATION,
      TAKOFORM_V2_MIGRATION,
      V2_MIGRATION_SET_CUSTODY,
      "0072_v2_artifact_custody.sql",
    ]);
    expect(database.query("SELECT * FROM tf_resources ORDER BY kind").all()).toEqual(before);
    expect(migrateSqlite(database).applied).toEqual([]);
  } finally {
    database.close();
  }
});

test("0067 index build tolerates malformed historical JSON without indexing it", () => {
  const database = new Database(":memory:");
  try {
    // Current Resource triggers reject malformed new writes. This minimal
    // table models a damaged historical row to prove the additive index build
    // itself never evaluates json_extract on invalid data.
    database.exec(`CREATE TABLE tf_resources (
      api_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      resource_json TEXT NOT NULL
    )`);
    database
      .query("INSERT INTO tf_resources VALUES ('edge.forms.takoform.com', 'ContainerEndpoint', ?)")
      .run("{malformed");
    database
      .query("INSERT INTO tf_resources VALUES ('edge.forms.takoform.com', 'ContainerEndpoint', ?)")
      .run(JSON.stringify({ status: { outputs: { hostname: HOSTNAME } } }));
    const migration = MIGRATIONS.find((entry) => entry.name === HOSTNAME_INDEX_MIGRATION);
    if (!migration) throw new Error("missing ContainerEndpoint hostname migration");
    expect(() => database.exec(migration.sql)).not.toThrow();
    const rows = database
      .query(
        `SELECT resource_json FROM tf_resources
         WHERE api_version = 'edge.forms.takoform.com'
           AND kind = 'ContainerEndpoint'
           AND CASE WHEN json_valid(resource_json) = 1
             THEN json_extract(resource_json, '$.status.outputs.hostname')
             ELSE NULL END = ?`,
      )
      .all(HOSTNAME);
    expect(rows).toHaveLength(1);
  } finally {
    database.close();
  }
});
