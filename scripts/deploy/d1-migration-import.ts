import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { preflightError } from "./errors.ts";
import type { MigrationFile } from "./migrations.ts";

const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_IMPORT_FILES = 128;

/** Pinned Wrangler 4.123.0 D1 SQL from getCreateMigrationsTableQuery/buildMigrationQuery. */
const WRANGLER_MIGRATION_LEDGER_DDL =
  'CREATE TABLE IF NOT EXISTS "d1_migrations"(\n' +
  "\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
  "\t\tname       TEXT UNIQUE,\n" +
  "\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n" +
  ");";

export interface D1MigrationImportOptions {
  readonly freshLedger: boolean;
}

export interface D1MigrationImportArtifact {
  readonly sql: string;
  readonly digest: `sha256:${string}`;
  readonly bytes: number;
}

/**
 * Builds one SQL file in Wrangler's migration format without rewriting any
 * migration source. The caller must obtain files from the audited source
 * qualification; this helper only validates their recorded bytes and safe
 * ordered names before composing the import.
 */
export function buildD1MigrationImport(
  files: readonly MigrationFile[],
  options: D1MigrationImportOptions,
): D1MigrationImportArtifact {
  if (!options || typeof options.freshLedger !== "boolean") {
    throw preflightError("D1 migration import requires a freshLedger boolean option");
  }
  if (!Array.isArray(files)) {
    throw preflightError("D1 migration import requires an ordered migration file array");
  }
  if (files.length === 0) throw preflightError("D1 migration import requires at least one file");
  if (files.length > MAX_IMPORT_FILES) {
    throw preflightError("D1 migration import exceeds the bounded file count");
  }

  const chunks: Buffer[] = [];
  if (options.freshLedger) chunks.push(Buffer.from(WRANGLER_MIGRATION_LEDGER_DDL, "utf8"));

  let previousMigrationNumber: number | null = null;
  for (const [index, file] of files.entries()) {
    previousMigrationNumber = validateMigrationFile(
      file,
      index,
      options.freshLedger,
      previousMigrationNumber,
    );
    let body: Buffer;
    try {
      body = readMigrationBytes(file);
    } catch {
      throw preflightError(`D1 migration import could not read ${file.name}`);
    }
    if (
      body.byteLength !== file.bytes ||
      !SHA256.test(file.digest) ||
      digestBytes(body) !== file.digest
    ) {
      throw preflightError(`D1 migration import source bytes changed for ${file.name}`);
    }
    // Match Wrangler's buildMigrationQuery exactly: source bytes, one newline,
    // then the ledger INSERT with the migration filename SQL-escaped.
    if (chunks.length > 0) chunks.push(Buffer.from("\n", "utf8"));
    chunks.push(body);
    chunks.push(Buffer.from(`\n${ledgerInsert(file.name)}`, "utf8"));
  }

  const output = Buffer.concat(chunks);
  let sql: string;
  try {
    sql = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output);
  } catch {
    throw preflightError("D1 migration import contains non-UTF-8 SQL bytes");
  }
  return {
    sql,
    digest: digestBytes(output),
    bytes: output.byteLength,
  };
}

function validateMigrationFile(
  file: MigrationFile,
  index: number,
  freshLedger: boolean,
  previousMigrationNumber: number | null,
): number {
  if (
    typeof file !== "object" ||
    file === null ||
    typeof file.name !== "string" ||
    typeof file.path !== "string" ||
    typeof file.digest !== "string" ||
    typeof file.bytes !== "number"
  ) {
    throw preflightError("D1 migration import received a malformed migration file");
  }
  const match = MIGRATION_NAME.exec(file.name);
  const migrationNumber = match === null ? null : Number(match[1]);
  const expectedNumber =
    freshLedger || previousMigrationNumber !== null
      ? (previousMigrationNumber ?? 0) + 1
      : migrationNumber;
  if (
    migrationNumber === null ||
    migrationNumber !== expectedNumber ||
    basename(file.path) !== file.name
  ) {
    throw preflightError(
      "D1 migration import requires one gap-free ordered migration filename",
      `position=${index + 1} name=${JSON.stringify(file.name)}`,
    );
  }
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 1) {
    throw preflightError(`D1 migration import has an invalid byte count for ${file.name}`);
  }
  return migrationNumber;
}

function readMigrationBytes(file: MigrationFile): Buffer {
  return readFileSync(resolve(file.path));
}

function ledgerInsert(name: string): string {
  return `INSERT INTO "d1_migrations" (name)\nvalues ('${name.replace(/'/g, "''")}');`;
}

function digestBytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
