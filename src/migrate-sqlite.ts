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
 */

export interface MigratableDatabase {
  exec(sql: string): unknown;
  query(sql: string): { all(...params: readonly unknown[]): unknown[] };
}

export interface MigrationReport {
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
}

export function migrateSqlite(database: MigratableDatabase): MigrationReport {
  // Avoid taking a write lock on the normal existing-database startup path.
  // If this read suggests a fresh file, repeat the proof after acquiring the
  // lock below so concurrent starters cannot rely on stale schema state.
  if (!hasEmptySchemaAndZeroHeaderMetadata(database)) {
    return migrateExistingDatabase(database);
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
    return migrateExistingDatabase(database);
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

function migrateExistingDatabase(database: MigratableDatabase): MigrationReport {
  // Existing, partial, and otherwise non-empty databases retain the historic
  // per-migration checkpoint behavior.
  createMigrationLedger(database);

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
      executeStatements(database, migration.sql);
      recordMigration(database, migration.name);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`migration ${migration.name} failed: ${String(error)}`);
    }
    applied.push(migration.name);
  }

  return { applied, alreadyApplied: already.size };
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
