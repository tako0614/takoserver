import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { MIGRATIONS } from "../../src/db-schema.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";

// Test fixtures replay the same migration chain hundreds of times, at about
// 0.7 s each. Each distinct statement list now runs once per test process, on
// the real chain, and every caller gets its own private writable copy (about
// 10 ms). The image holds only database content: connection settings such as
// foreign_keys or recursive_triggers are not part of it, so callers keep
// applying them to each copy exactly as before.
const images = new Map<string, Uint8Array>();

function cached(key: string, build: (database: Database) => void): Uint8Array {
  let image = images.get(key);
  if (image === undefined) {
    const database = new Database(":memory:");
    try {
      build(database);
      image = database.serialize();
    } finally {
      database.close();
    }
    images.set(key, image);
  }
  return image;
}

function imageOf(statements: readonly string[]): Uint8Array {
  const key = createHash("sha256").update(JSON.stringify(statements)).digest("hex");
  return cached(`statements:${key}`, (database) => {
    for (const statement of statements) database.exec(statement);
  });
}

const open = (image: Uint8Array, options: { readonly strict?: boolean }): Database =>
  options.strict === true
    ? Database.deserialize(image, { strict: true })
    : Database.deserialize(image);

const chainOf = (count: number): readonly string[] => {
  if (!Number.isInteger(count) || count < 0 || count > MIGRATIONS.length)
    throw new RangeError(`no migration prefix of length ${count}`);
  return MIGRATIONS.slice(0, count).map((migration) => migration.sql);
};

/**
 * A private in-memory copy of whatever `build` produces on a fresh database.
 * `key` must name everything `build` depends on; `build` runs once per key.
 */
export function databaseBuiltOnce(
  key: string,
  build: (database: Database) => void,
  options: { readonly strict?: boolean } = {},
): Database {
  return open(cached(`built:${key}`, build), options);
}

/** A private in-memory copy of the database after exactly these statements. */
export function databaseAfter(
  statements: readonly string[],
  options: { readonly strict?: boolean } = {},
): Database {
  return open(imageOf(statements), options);
}

/** A private in-memory copy of the database after the first `count` migrations (default: all). */
export function migratedDatabase(
  count: number = MIGRATIONS.length,
  options: { readonly strict?: boolean } = {},
): Database {
  return databaseAfter(chainOf(count), options);
}

/** Writes the database after the first `count` migrations to a new file at `path`. */
export function writeMigratedDatabaseFile(path: string, count: number = MIGRATIONS.length): void {
  if (!isAbsolute(path)) throw new TypeError("migrated database files need an absolute path");
  writeFileSync(path, imageOf(chainOf(count)), { flag: "wx", mode: 0o600 });
}

/**
 * A private in-memory copy of a fresh database after `migrateSqlite` (schema
 * plus its applied_migrations ledger). Tests about the migrator itself keep
 * calling it directly; every copy shares the image's applied_at instants.
 */
const migrateSqliteImage = (): Uint8Array =>
  cached("migrateSqlite", (database) => {
    migrateSqlite(database);
  });

export function migrateSqliteDatabase(options: { readonly strict?: boolean } = {}): Database {
  return open(migrateSqliteImage(), options);
}

/** Writes a fresh database after `migrateSqlite` to a new file at `path`. */
export function writeMigrateSqliteFile(path: string): void {
  if (!isAbsolute(path)) throw new TypeError("migrated database files need an absolute path");
  writeFileSync(path, migrateSqliteImage(), { flag: "wx", mode: 0o600 });
}
