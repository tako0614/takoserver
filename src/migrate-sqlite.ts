import { MIGRATIONS } from "./db-schema.ts";

/**
 * Bringing a local database up to the schema this build expects.
 *
 * A self-hosted deployment starts with an empty file, and until now the first
 * run produced a server that answered every request with "no such table" — the
 * migrations were applied only to an in-memory database, which is to say only
 * in tests. That is the difference between software somebody can run and
 * software that runs here.
 *
 * Forward only, and recorded. Existing databases keep one transaction per
 * migration as a recovery checkpoint. A truly fresh database applies the
 * complete schema and ledger in one transaction, so a failed first boot
 * returns to an empty database rather than an arbitrary partial prefix.
 *
 * A file carrying a migration this build has never heard of is refused rather
 * than repaired. It came from a newer build, and the safe thing to do with a
 * database from the future is nothing at all.
 *
 * A used installation of the published v1.0.0 release is refused too, before
 * the first write: this build serves Takoform Host API v2, v1.0.0 to v2 is a
 * breaking major with no in-place upgrade, and leaving the file exactly as
 * v1.0.0 wrote it is what keeps that release able to run on it again.
 */

export interface MigratableDatabase {
  exec(sql: string): unknown;
  query(sql: string): { all(...params: readonly unknown[]): unknown[] };
}

export interface MigrationReport {
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
}

export interface MigrationOptions {
  /**
   * The installation this database belongs to, named in a refusal so the
   * operator can tell which files were refused. In-memory callers omit it.
   */
  readonly installation?: {
    readonly dataRoot: string;
    readonly databasePath: string;
    /**
     * True when `TAKOSERVER_DB` names this database instead of the data root's
     * own `control.sqlite`; the refusal then names that file, not the root.
     */
    readonly externalDatabase?: boolean;
  };
}

/** The last migration the published v1.0.0 release applies and records. */
const V1_RELEASE_LAST_MIGRATION = "0015_takoform_resource_relations.sql";

/**
 * The first migration that cannot carry v1 history forward. Its SQL refuses
 * any wallet ledger row (credit lots cannot be reconstructed from the v1
 * append-only ledger); the boundary below refuses the same history before any
 * earlier migration has written, and says why.
 */
const WALLET_CREDIT_LOTS_MIGRATION = "0017_wallet_credit_lots.sql";

const WALLET_USD_MICROS_MIGRATION = "0094_wallet_usd_micros.sql";

/** Existing money requires a separately reviewed, stopped-writer cutover. */
export class MoneyUnitCutoverRequiredError extends Error {
  constructor() {
    super(
      "Existing billing history requires an independently qualified 0093 classification preparation " +
        "and 0094 USD-micros cutover. Automatic startup migration is refused before any write. " +
        "Keep the cents artifact stopped during that owner procedure; do not reset balances, " +
        "seed an unqualified 0092 schema, or bypass this guard. See docs/org-billing-micros.md.",
    );
    this.name = "MoneyUnitCutoverRequiredError";
  }
}

function moneyCutoverAlreadyApplied(database: MigratableDatabase): boolean {
  return (
    hasTable(database, "applied_migrations") &&
    (database.query("SELECT name FROM applied_migrations").all() as { name: string }[]).some(
      (row) => row.name === WALLET_USD_MICROS_MIGRATION,
    )
  );
}

function refuseAutomaticMoneyCutover(database: MigratableDatabase): void {
  if (moneyCutoverAlreadyApplied(database)) return;
  // A partial predecessor may not have these tables yet. Schema history alone
  // is not money history, and never permits a populated cents wallet to pass.
  for (const table of [
    "ledger",
    "wallet_credit_lots",
    "wallet_credit_allocations",
    "org_wallet_holds",
    "org_wallet_usage_records",
    "org_wallet_grant_snapshots",
    "org_wallet_monthly_tariffs",
    "usage_events",
    "stripe_events",
    "reseller_settlement_intents",
    "reservations",
    "quotes",
    "usage_statements",
    "wallet_credit_lot_classification_proofs",
  ]) {
    if (
      hasTable(database, table) &&
      database.query(`SELECT 1 FROM ${table} LIMIT 1`).all().length > 0
    )
      throw new MoneyUnitCutoverRequiredError();
  }
  if (
    hasTable(database, "idempotency") &&
    database.query("SELECT 1 FROM idempotency WHERE scope_key LIKE 'ai:%' LIMIT 1").all().length > 0
  )
    throw new MoneyUnitCutoverRequiredError();
}

/** The v1 state that identifies a control database as a used installation. */
export interface UsedV1Installation {
  /** The newest recorded migration, at or before 0016. */
  readonly lastRecordedMigration: string;
  /**
   * Whether the recorded history includes every migration v1.0.0 applies.
   * Without it the file predates the release, and v1.0.0 would first apply
   * its own remaining migrations to it.
   */
  readonly v1ReleaseHistory: boolean;
  /**
   * Migrations after v1.0.0's last one that an earlier start of a newer,
   * pre-boundary build recorded before failing at 0017. v1.0.0 refuses a
   * database that records any of them.
   */
  readonly recordedAfterV1Release: readonly string[];
  readonly ledgerEntries: number;
  /** v1 Takoform Resources; v1.0.0 deletes the row when a Resource is deleted. */
  readonly v1Resources: number;
  /** Provider Deployments not yet deleted, i.e. provider state still held. */
  readonly v1ProviderDeployments: number;
}

/**
 * Refuses, before the first write, to upgrade a used v1 installation in place.
 *
 * `error.message` is the whole operator-facing explanation: which files, why,
 * that nothing was changed, and where the supported path is documented.
 */
export class UsedV1InstallationError extends Error {
  readonly installation: UsedV1Installation;

  constructor(installation: UsedV1Installation, options: MigrationOptions = {}) {
    super(describeUsedV1Installation(installation, options));
    this.name = "UsedV1InstallationError";
    this.installation = installation;
  }
}

/**
 * Throws `UsedV1InstallationError` when the database is a used v1
 * installation. It only reads, so a read-only handle is enough; the Bun entry
 * calls it that way before it creates a missing data root.
 */
export function refuseUsedV1Installation(
  database: MigratableDatabase,
  options: MigrationOptions = {},
): void {
  const usedV1 = inspectUsedV1Installation(database);
  if (usedV1) throw new UsedV1InstallationError(usedV1, options);
}

export function migrateSqlite(
  database: MigratableDatabase,
  options: MigrationOptions = {},
): MigrationReport {
  // Avoid taking a write lock on the normal existing-database startup path.
  // If this read suggests a fresh file, repeat the proof after acquiring the
  // lock below so concurrent starters cannot rely on stale schema state.
  if (!hasEmptySchemaAndZeroHeaderMetadata(database)) {
    return migrateExistingDatabase(database, options);
  }

  // Keep first boot atomic as a whole: a fresh file is not useful after only
  // an arbitrary prefix of the schema exists. The lock covers both the
  // emptiness proof and migration application so concurrent starters cannot
  // both make this decision against stale schema state.
  database.exec("BEGIN IMMEDIATE");
  let stillTrulyFresh = false;
  try {
    stillTrulyFresh = hasEmptySchemaAndZeroHeaderMetadata(database);
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
  if (!stillTrulyFresh) {
    database.exec("ROLLBACK");
    return migrateExistingDatabase(database, options);
  }

  return bootstrapFreshDatabase(database);
}

function hasEmptySchemaAndZeroHeaderMetadata(database: MigratableDatabase): boolean {
  const schemaObjects = database.query("SELECT 1 FROM sqlite_schema LIMIT 1").all();
  const userVersion = database.query("PRAGMA user_version").all() as {
    user_version: number;
  }[];
  const applicationId = database.query("PRAGMA application_id").all() as {
    application_id: number;
  }[];
  return (
    schemaObjects.length === 0 &&
    userVersion[0]?.user_version === 0 &&
    applicationId[0]?.application_id === 0
  );
}

function migrateExistingDatabase(
  database: MigratableDatabase,
  options: MigrationOptions,
): MigrationReport {
  // Reads only, and first: a used v1 installation is refused while the file is
  // still byte-for-byte what v1.0.0 wrote.
  refuseUsedV1Installation(database, options);
  refuseAutomaticMoneyCutover(database);

  // Existing, partial, and otherwise non-empty databases retain the historic
  // per-migration checkpoint behavior.
  // The already-qualified micros restart stays read-only, including without
  // a write lock. Before the cutover, acquire the lock and repeat the money
  // history proof before even creating the checkpoint table.
  if (!moneyCutoverAlreadyApplied(database)) {
    database.exec("BEGIN IMMEDIATE");
    try {
      refuseUsedV1Installation(database, options);
      refuseAutomaticMoneyCutover(database);
      createMigrationLedger(database);
      database.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  }

  const rows = database.query("SELECT name FROM applied_migrations").all() as {
    name: string;
  }[];
  const already = new Set(rows.map((row) => row.name));

  const known = new Set(MIGRATIONS.map((migration) => migration.name));
  const unknown = [...already].filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `this database has migrations this build does not know: ${unknown.join(", ")}. ` +
        "It was written by a newer Takoserver; upgrade rather than downgrade.",
    );
  }

  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (already.has(migration.name)) continue;
    // One transaction per migration: a crash lands on a version, never between
    // two of them.
    database.exec("BEGIN IMMEDIATE");
    try {
      // The check above held no lock. Repeat it under the first write lock so
      // a v1 write that landed in between is refused, not migrated over. Once
      // that migration commits, the file is no longer what v1.0.0 wrote; a v1
      // writer still running after it is outside the stopped-writers premise.
      if (applied.length === 0) {
        refuseUsedV1Installation(database, options);
        refuseAutomaticMoneyCutover(database);
      }
      if (
        migration.name === "0093_wallet_credit_classification_proofs.sql" ||
        migration.name === WALLET_USD_MICROS_MIGRATION
      )
        refuseAutomaticMoneyCutover(database);
      executeStatements(database, migration.sql);
      recordMigration(database, migration.name);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      if (
        error instanceof UsedV1InstallationError ||
        error instanceof MoneyUnitCutoverRequiredError
      )
        throw error;
      throw new Error(`migration ${migration.name} failed: ${String(error)}`);
    }
    applied.push(migration.name);
  }

  return { applied, alreadyApplied: already.size };
}

/**
 * Recognizes, by reads alone, a control database that a used v1 installation
 * left behind and that this build must not migrate.
 *
 * The recorded history must lie wholly before 0017: v1.0.0 records exactly
 * 0001-0015, and an earlier start of a pre-boundary newer build may have
 * added 0016 before failing at 0017. Any other history (past the boundary, or
 * carrying a name this build does not know) takes the ordinary path, which
 * refuses an unknown migration by itself.
 *
 * Use is what 0017 would refuse, a wallet ledger row, plus v1 Resource state
 * that the v2 Host cannot serve: a v1 Takoform Resource or a provider
 * Deployment that was never deleted. Resource state is read only for the
 * release's own history; pre-release lineages keep their pinned forward
 * migrations. A v1 database with neither (booted, or signed in with an
 * Organization and API keys but never funded) keeps migrating as before.
 */
function inspectUsedV1Installation(database: MigratableDatabase): UsedV1Installation | undefined {
  if (!hasTable(database, "applied_migrations")) return undefined;
  const recorded = new Set(
    (database.query("SELECT name FROM applied_migrations").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  const boundary = migrationIndex(WALLET_CREDIT_LOTS_MIGRATION);
  const releaseEnd = migrationIndex(V1_RELEASE_LAST_MIGRATION);
  const recordedBeforeBoundary = MIGRATIONS.slice(0, boundary).filter((migration) =>
    recorded.has(migration.name),
  );
  if (recorded.size === 0 || recordedBeforeBoundary.length !== recorded.size) return undefined;

  const v1ReleaseHistory = MIGRATIONS.slice(0, releaseEnd + 1).every((migration) =>
    recorded.has(migration.name),
  );
  const ledgerEntries = countRows(database, "ledger");
  const v1Resources = v1ReleaseHistory ? countRows(database, "tf_resources") : 0;
  const v1ProviderDeployments = v1ReleaseHistory
    ? countRows(database, "tf_resource_deployments", "state <> 'deleted'")
    : 0;
  if (ledgerEntries === 0 && v1Resources === 0 && v1ProviderDeployments === 0) return undefined;

  return {
    lastRecordedMigration: recordedBeforeBoundary[recordedBeforeBoundary.length - 1]?.name ?? "",
    v1ReleaseHistory,
    recordedAfterV1Release: MIGRATIONS.slice(releaseEnd + 1, boundary)
      .filter((migration) => recorded.has(migration.name))
      .map((migration) => migration.name),
    ledgerEntries,
    v1Resources,
    v1ProviderDeployments,
  };
}

/** The one operator-facing explanation of a used v1 installation refusal. */
function describeUsedV1Installation(found: UsedV1Installation, options: MigrationOptions): string {
  const installation = options.installation;
  const external = installation?.externalDatabase === true;
  const files = !installation
    ? "this control database"
    : external
      ? `control database ${installation.databasePath} (TAKOSERVER_DB)`
      : `data root ${installation.dataRoot} (control database ${installation.databasePath})`;
  const history = found.v1ReleaseHistory
    ? `it records the migrations of the Takoserver v1.0.0 release (ending at ${found.lastRecordedMigration})`
    : `it records only migrations from before the Takoserver v1.0.0 release (ending at ${found.lastRecordedMigration})`;
  const state = [
    quantity(found.ledgerEntries, "wallet ledger entry", "wallet ledger entries"),
    quantity(found.v1Resources, "v1 Takoform Resource", "v1 Takoform Resources"),
    quantity(found.v1ProviderDeployments, "v1 provider Deployment", "v1 provider Deployments"),
  ]
    .filter((entry) => entry !== undefined)
    .join(", ");
  const subject = installation && !external ? "this data root" : "this database";
  const keep =
    installation && external
      ? `Leave ${installation.databasePath} as it is: point TAKOSERVER_DB at a new file or unset it, use a data root that v1.0.0 did not use, then recreate the Resources through the v2 API.`
      : `Leave ${subject} as it is and start this build on a new, empty TAKOSERVER_DATA_ROOT (and a new TAKOSERVER_DB, if one is set), then recreate the Resources through the v2 API.`;
  const oldRelease =
    found.recordedAfterV1Release.length > 0
      ? ` An earlier start of a newer build already recorded ${found.recordedAfterV1Release.join(", ")} here, so v1.0.0 refuses this file too; run v1.0.0 only on a copy taken before that start.`
      : found.v1ReleaseHistory
        ? ` The v1.0.0 release can still run on ${subject}.`
        : "";
  return [
    `Takoserver will not start on ${files}: ${history} and holds v1 state: ${state}.`,
    "This build serves Takoform Host API v2 and does not upgrade a used v1 installation in place. It stopped before writing to the database; the database is unchanged.",
    `${keep}${oldRelease}`,
    `See "Upgrading from v1.0.0" in docs/self-host-operations.md: ${UPGRADING_FROM_V1_DOCUMENTATION}`,
  ].join("\n");
}

const UPGRADING_FROM_V1_DOCUMENTATION =
  "https://github.com/tako0614/takoserver/blob/main/docs/self-host-operations.md#upgrading-from-v100";

function quantity(count: number, one: string, many: string): string | undefined {
  if (count === 0) return undefined;
  return `${count} ${count === 1 ? one : many}`;
}

function migrationIndex(name: string): number {
  const index = MIGRATIONS.findIndex((migration) => migration.name === name);
  if (index < 0) throw new Error(`the v1 upgrade boundary needs migration ${name}`);
  return index;
}

function hasTable(database: MigratableDatabase, name: string): boolean {
  return (
    database.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").all(name)
      .length > 0
  );
}

/** Counts rows of a fixed v1 table, or zero when that table does not exist. */
function countRows(database: MigratableDatabase, table: string, where?: string): number {
  if (!hasTable(database, table)) return 0;
  const rows = database
    .query(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`)
    .all() as { count: number }[];
  return Number(rows[0]?.count ?? 0);
}

function bootstrapFreshDatabase(database: MigratableDatabase): MigrationReport {
  const applied: string[] = [];
  let currentMigration = "fresh schema bootstrap";
  try {
    createMigrationLedger(database);

    for (const migration of MIGRATIONS) {
      currentMigration = migration.name;
      executeStatements(database, migration.sql);
      recordMigration(database, migration.name);
      applied.push(migration.name);
    }

    database.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(database);
    throw new Error(`migration ${currentMigration} failed: ${String(error)}`);
  }

  return { applied, alreadyApplied: 0 };
}

function rollbackQuietly(database: MigratableDatabase): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // COMMIT may have succeeded even if its acknowledgement was lost. Preserve
    // the original error; a later invocation will read the committed ledger.
  }
}

function recordMigration(database: MigratableDatabase, name: string): void {
  database.exec(
    `INSERT INTO applied_migrations (name, applied_at) VALUES ('${name}', datetime('now'))`,
  );
}

function createMigrationLedger(database: MigratableDatabase): void {
  // Keep the original DDL bytes so fresh and existing paths produce the same
  // canonical sqlite_schema SQL text.
  database.exec(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Bun's `Database.exec()` may stop at a failed statement in a multi-statement
 * string without surfacing that intermediate error. Migrations need the
 * opposite contract, so execute the repository's deliberately simple SQL
 * files statement-by-statement after removing line comments.
 */
function executeStatements(database: MigratableDatabase, sql: string): void {
  const statements = splitStatements(sql.replace(/^\s*--.*$/gmu, ""));
  for (const statement of statements) database.exec(statement);
}

/**
 * Migration files are intentionally simple, with one exception: SQLite
 * triggers contain semicolon-delimited statements inside `BEGIN ... END`.
 * Preserve each complete trigger as one statement while retaining the
 * intermediate-error visibility that a raw multi-statement `exec` lacks.
 */
function splitStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  let rest = sql.trim();
  while (rest.length > 0) {
    if (/^CREATE\s+TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end) throw new Error("incomplete CREATE TRIGGER in migration");
      const boundary = (end.index ?? 0) + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement.length > 0) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}
