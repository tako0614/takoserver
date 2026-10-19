import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalSchemaShape, type D1SchemaState } from "../../scripts/deploy/migrations.ts";
import { readCurrentAuditedMigrationSourceArtifact } from "../../scripts/deploy/schema.ts";
import { MIGRATIONS, type Migration } from "../../src/db-schema.ts";

const APPLY_QUALIFIED_MIGRATION_END = "0066_cloudflare_managed_actor_kv_capability_claims.sql";

/** The source auditor owns the current tail; this independently checks generated SQL bytes. */
export function currentAuditedSchemaMigrations(): readonly Migration[] {
  const source = readCurrentAuditedMigrationSourceArtifact();
  if (
    MIGRATIONS.length !== source.files.length ||
    MIGRATIONS.some(
      (migration, index) =>
        migration.name !== source.files[index]?.name ||
        migration.sql !== readFileSync(source.files[index].path, "utf8"),
    )
  ) {
    throw new Error("generated schema fixture differs from the exact audited current source");
  }
  return MIGRATIONS;
}

function applyQualifiedMigrations() {
  const migrations = currentAuditedSchemaMigrations();
  const endIndex = migrations.findIndex(({ name }) => name === APPLY_QUALIFIED_MIGRATION_END);
  if (endIndex !== 65) {
    throw new Error("apply-qualified schema fixture requires the exact audited 0001-0066 prefix");
  }
  return migrations.slice(0, endIndex + 1);
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
  const prefix = currentAuditedSchemaMigrations().slice(0, 49);
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
 * Worker native-effect custody, source-only 0075 artifact progress,
 * source-only 0076 Worker invocation custody, and source-only 0077
 * Operation acceptance order, and source-only 0078 provider-confirmed Worker
 * invocation retirement, source-only 0079 Worker native deletion custody,
 * and later source-only additions validated by the current source auditor. */
export function copyCurrentSchemaFixture(directory: string): string {
  const migrations = currentAuditedSchemaMigrations();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const { name } of migrations) {
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

/** Read-only facts from a separately created fresh full100 SQLite file.
 * This records an observation; no expected shape/baseline or D1 apply grant is inferred.
 */
export interface Full100FreshSqliteObservation {
  readonly kind: "takoserver.full100-fresh-sqlite-observation@v1";
  readonly persistedMigrationCount: number;
  readonly persistedNamesDigest: string;
  readonly persistedLedgerFieldsDigest: string;
  readonly persistedSqlChecksumAvailable: false;
  readonly schemaShapeDigest: string;
  readonly schemaNamesDigest: string;
  readonly schemaObjectTypeCounts: Readonly<Record<string, number>>;
  readonly foreignKeyViolationCount: number;
  readonly tableBaselines: readonly {
    readonly name: string;
    readonly rowCount: number;
    readonly typedRowMultisetDigest: string;
  }[];
}

function full100Digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function full100QuotedCatalogName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("full100 SQLite catalog contains an invalid table name");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function full100TypedCell(value: unknown): readonly [string, string?] {
  if (value === null) return ["null"];
  if (typeof value === "string") return ["text-sha256", full100Digest(value)];
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (typeof value === "number") {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error("full100 SQLite integer exceeds exact JavaScript number range");
    }
    return ["number", Object.is(value, -0) ? "-0" : String(value)];
  }
  if (value instanceof Uint8Array) {
    return ["blob-sha256", `${value.byteLength}:${full100Digest(value)}`];
  }
  throw new Error("full100 SQLite row contains an unsupported value type");
}

function full100TypedRowDigest(row: Record<string, unknown>): string {
  const columns = Object.keys(row).sort();
  const canonical = columns.map((name) => [name, full100TypedCell(row[name])]);
  return full100Digest(JSON.stringify(canonical));
}

function inspectFull100FreshSqliteInternal(
  database: Pick<Database, "query">,
): Full100FreshSqliteObservation {
  const source = currentAuditedSchemaMigrations();
  if (source.length !== 100 || !source[99]?.name.startsWith("0100_")) {
    throw new Error("full100 inspection requires the exact audited 100-source boundary");
  }
  // migrateSqlite's actual persisted ledger has name and applied_at only.
  const ledger = database
    .query("SELECT name, applied_at FROM main.applied_migrations ORDER BY rowid")
    .all() as { name: unknown; applied_at: unknown }[];
  if (
    ledger.length !== 100 ||
    ledger.some(
      (row, index) =>
        row.name !== source[index]?.name ||
        typeof row.applied_at !== "string" ||
        row.applied_at.length === 0,
    )
  ) {
    throw new Error("persisted full100 migration ledger differs from audited source order");
  }

  // Existing canonicalSchemaShape owns normalization; its raw shape stays in memory.
  const catalog = database
    .query(
      "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql " +
        "FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
    )
    .all() as Record<string, unknown>[];
  catalog.sort((a, b) => `${a.type}\0${a.name}`.localeCompare(`${b.type}\0${b.name}`));
  const shape = canonicalSchemaShape(catalog);
  const schemaObjectTypeCounts: Record<string, number> = Object.create(null);
  for (const row of catalog) {
    const type = String(row.type);
    schemaObjectTypeCounts[type] = (schemaObjectTypeCounts[type] ?? 0) + 1;
  }
  const foreignKeyViolationCount = database.query("PRAGMA main.foreign_key_check").all().length;
  const tableBaselines = catalog
    .filter((row) => row.type === "table" && row.name !== "applied_migrations")
    .map((row) => {
      const name = row.name;
      const rows = database
        .query(`SELECT * FROM main.${full100QuotedCatalogName(name)}`)
        .all() as Record<string, unknown>[];
      const digests = rows.map(full100TypedRowDigest).sort();
      return {
        name: String(name),
        rowCount: rows.length,
        typedRowMultisetDigest: full100Digest(JSON.stringify([name, digests])),
      };
    });
  return {
    kind: "takoserver.full100-fresh-sqlite-observation@v1",
    persistedMigrationCount: ledger.length,
    persistedNamesDigest: full100Digest(JSON.stringify(ledger.map((row) => row.name))),
    persistedLedgerFieldsDigest: full100Digest(
      JSON.stringify(ledger.map((row) => [row.name, row.applied_at])),
    ),
    persistedSqlChecksumAvailable: false,
    schemaShapeDigest: full100Digest(shape),
    schemaNamesDigest: full100Digest(
      JSON.stringify(catalog.map((row) => [row.type, row.name, row.tbl_name])),
    ),
    schemaObjectTypeCounts,
    foreignKeyViolationCount,
    tableBaselines,
  };
}

export function inspectFull100FreshSqlite(
  database: Pick<Database, "query">,
): Full100FreshSqliteObservation {
  try {
    return inspectFull100FreshSqliteInternal(database);
  } catch (error) {
    // SQLite or canonicalizer failures may include query/schema text; no raw cause.
    throw new Error(
      `full100 readonly inspection failed (opaque diagnostic ${full100Digest(String(error))})`,
    );
  }
}
