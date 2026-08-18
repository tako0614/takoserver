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
 * Forward only, and recorded. Each migration is applied inside a transaction
 * and its name written in the same transaction, so a crash halfway leaves the
 * file at a version rather than between two.
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
  database.exec(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

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
      database.exec(
        `INSERT INTO applied_migrations (name, applied_at) VALUES ('${migration.name}', datetime('now'))`,
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`migration ${migration.name} failed: ${String(error)}`);
    }
    applied.push(migration.name);
  }

  return { applied, alreadyApplied: already.size };
}

/**
 * Bun's `Database.exec()` may stop at a failed statement in a multi-statement
 * string without surfacing that intermediate error. Migrations need the
 * opposite contract, so execute the repository's deliberately simple SQL
 * files statement-by-statement after removing line comments.
 */
function executeStatements(database: MigratableDatabase, sql: string): void {
  const statements = sql
    .replace(/^\s*--.*$/gmu, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) database.exec(statement);
}
