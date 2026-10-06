import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalSchemaShape, type D1SchemaState } from "../../scripts/deploy/migrations.ts";
import { MIGRATIONS } from "../../src/db-schema.ts";

const APPLY_QUALIFIED_MIGRATION_END = "0066_cloudflare_managed_actor_kv_capability_claims.sql";
const CURRENT_SOURCE_MIGRATION_END = "0075_v2_artifact_progress.sql";

function applyQualifiedMigrations() {
  const endIndex = MIGRATIONS.findIndex(({ name }) => name === APPLY_QUALIFIED_MIGRATION_END);
  if (
    endIndex !== 65 ||
    MIGRATIONS.length !== 75 ||
    MIGRATIONS.at(-1)?.name !== CURRENT_SOURCE_MIGRATION_END
  ) {
    throw new Error("apply-qualified schema fixture requires the exact audited 0001-0066 prefix");
  }
  return MIGRATIONS.slice(0, endIndex + 1);
}

/** Names present in deployed D1 under the existing 0001-0066 apply qualification. */
export function applyQualifiedMigrationNames(): readonly string[] {
  return applyQualifiedMigrations().map(({ name }) => name);
}

/** Actual D1 readback fixture for the existing apply-qualified 0001-0066 schema. */
export function applyQualifiedSchemaState(): D1SchemaState {
  const migrations = applyQualifiedMigrations();
  const database = new Database(":memory:");
  try {
    for (const { name } of migrations) {
      database.exec(readFileSync(resolve(import.meta.dir, "../../migrations", name), "utf8"));
    }
    const rows = database
      .query(
        "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql " +
          "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Record<string, unknown>[];
    const shape = canonicalSchemaShape(
      rows.filter(
        (row) =>
          row.name !== "d1_migrations" &&
          row.tbl_name !== "d1_migrations" &&
          row.name !== "_cf_KV" &&
          row.tbl_name !== "_cf_KV",
      ),
    );
    return {
      applied: migrations.map(({ name }) => name),
      shape,
      shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
    };
  } finally {
    database.close();
  }
}

/** Frozen catch-up-wave source, distinct from the current integration schema. */
export function copyAuditedSchemaFixture(directory: string): string {
  const prefix = MIGRATIONS.slice(0, 49);
  if (prefix.at(-1)?.name !== "0049_artifact_consumer_active_resolution.sql") {
    throw new Error("audited schema fixture requires the historical 0001-0049 prefix");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const { name } of prefix) {
    // Copy the actual source bytes: the production guard still checks every
    // frozen filename and hash, so an edited historical migration must fail.
    copyFileSync(resolve(import.meta.dir, "../../migrations", name), join(directory, name));
  }
  return directory;
}

/** Current audited source, including the additive 0050/0051 workflow tables,
 * 0052 termination intent, 0053 Queue custody state, its 0054 bounded
 * readiness index, its 0055 durable transfer notices, the 0056 bounded
 * VectorIndex SQL store, the 0057 execution-material tables, 0058 managed
 * Worker domain receipts, 0059 apply provider selection, 0060 operation
 * generation, 0061 accepted authority continuity, and 0062 import provider
 * selection, 0063 managed Queue retirement fencing, 0064 staged Actor owner
 * claims, 0065 runtime-input lease generation, 0066 Actor KV capability
 * claims, source-only audited 0067 hostname lookup index, source-only 0068
 * Cloudflare provider invocation custody schema, source-only 0069
 * WorkerVersion delete acknowledgement proof, source-only 0070 v2 Host core,
 * source-only 0071 Migration Set custody, source-only 0072 shared artifact custody,
 * source-only 0073 accepted reference protection, source-only 0074
 * Worker native-effect custody, and source-only 0075 artifact progress. */
export function copyCurrentSchemaFixture(directory: string): string {
  if (MIGRATIONS.length !== 75 || MIGRATIONS.at(-1)?.name !== CURRENT_SOURCE_MIGRATION_END) {
    throw new Error("current schema fixture requires the audited 0001-0075 source inventory");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const { name } of MIGRATIONS) {
    copyFileSync(resolve(import.meta.dir, "../../migrations", name), join(directory, name));
  }
  return directory;
}

/** Frozen 0001-0060 source used only by historical operation-generation tests. */
export function copyOperationGenerationSchemaFixture(directory: string): string {
  const prefix = MIGRATIONS.slice(0, 60);
  if (prefix.length !== 60 || prefix.at(-1)?.name !== "0060_takoform_operation_generation.sql") {
    throw new Error("operation-generation fixture requires the frozen 0001-0060 lineage");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const { name } of prefix) {
    copyFileSync(resolve(import.meta.dir, "../../migrations", name), join(directory, name));
  }
  return directory;
}
