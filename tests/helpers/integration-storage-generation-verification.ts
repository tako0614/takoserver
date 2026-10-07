import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  IntegrationStorageGenerationTargetVerificationOptions,
  IntegrationStorageTargetReadProvider,
} from "../../scripts/deploy/integration-storage-generation.ts";
import { canonicalSchemaShape, type D1SchemaState } from "../../scripts/deploy/migrations.ts";
import type { DeployTarget } from "../../scripts/deploy/target.ts";
import { MIGRATIONS } from "../../src/db-schema.ts";

const MIGRATION_DIRECTORY = resolve(import.meta.dir, "../../migrations");
const FRESH_V2_ARTIFACT_END = "0075_v2_artifact_progress.sql";
const CURRENT_SOURCE_END = "0076_v2_worker_invocation_custody.sql";

/** Qualified generated storage has the fixed 0075 payload, while source includes 0076. */
export function completeIntegrationStorageState(): D1SchemaState {
  if (
    MIGRATIONS.length !== 76 ||
    MIGRATIONS.at(74)?.name !== FRESH_V2_ARTIFACT_END ||
    MIGRATIONS.at(-1)?.name !== CURRENT_SOURCE_END
  ) {
    throw new Error("fixed v2 artifact fixture requires the audited 0001-0076 source inventory");
  }
  const migrations = MIGRATIONS.slice(0, 75);
  const database = new Database(":memory:");
  try {
    for (const { name } of migrations) {
      database.exec(readFileSync(resolve(MIGRATION_DIRECTORY, name), "utf8"));
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

export function integrationStorageVerificationOptions(
  target: DeployTarget,
  input: {
    readonly readState?: () => Promise<D1SchemaState>;
    readonly provider?: IntegrationStorageTargetReadProvider;
  } = {},
): Omit<IntegrationStorageGenerationTargetVerificationOptions, "run" | "cloudflareEnvironment"> {
  return {
    provider:
      input.provider ??
      ({
        async getD1(databaseId) {
          return { uuid: databaseId, name: target.d1.databaseName };
        },
        async getR2(name) {
          return { name };
        },
      } satisfies IntegrationStorageTargetReadProvider),
    reader: { read: input.readState ?? (async () => completeIntegrationStorageState()) },
    migrationDirectory: MIGRATION_DIRECTORY,
  };
}
