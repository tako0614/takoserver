import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { preflightError } from "./errors.ts";
import { canonicalSchemaShape, type D1SchemaState, type MigrationFile } from "./migrations.ts";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

/**
 * Reconstruct the schema expected from the sealed SQL before any provider
 * mutation. The comparison deliberately ignores only the platform-owned
 * migration/KV metadata rows that do not belong to the application schema.
 */
export function deriveExpectedApplicationShape(files: readonly MigrationFile[]): string {
  const database = new Database(":memory:");
  try {
    for (const file of files) {
      database.exec(readFileSync(file.path, "utf8"));
    }
    const rows = database
      .query(
        "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql " +
          "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Record<string, unknown>[];
    return canonicalSchemaShape(rows.filter((row) => !isPlatformSchemaMetadata(row)));
  } catch {
    throw preflightError("audited migrations could not reconstruct the expected canonical schema");
  } finally {
    database.close();
  }
}

/**
 * Validate a D1 shape readback and compare only application-owned schema rows.
 * The raw shape digest remains strict; SQL trivia is the sole tolerated
 * readback difference in the application-owned definitions.
 */
export function applicationSchemaMatches(state: D1SchemaState, expectedShape: string): boolean {
  if (!SHA256.test(state.shapeDigest) || state.shapeDigest !== digestShape(state.shape)) {
    return false;
  }
  let actualShape: string;
  try {
    actualShape = canonicalApplicationShape(state);
  } catch {
    return false;
  }
  return sameApplicationSchemaWithSqlTrivia(expectedShape, actualShape);
}

/** Strictly parse and canonicalize an application schema from a D1 readback. */
export function canonicalApplicationShape(state: D1SchemaState): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state.shape);
  } catch {
    throw preflightError("D1 canonical schema shape is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw preflightError("D1 canonical schema shape is not an array");
  }
  const rows = parsed.map((entry) => {
    if (!isRecord(entry)) {
      throw preflightError("D1 canonical schema shape contains a malformed row");
    }
    const keys = Object.keys(entry).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["name", "sql", "table", "type"])) {
      throw preflightError("D1 canonical schema shape contains an unexpected row");
    }
    if (
      typeof entry.type !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.table !== "string" ||
      typeof entry.sql !== "string"
    ) {
      throw preflightError("D1 canonical schema shape contains a malformed row");
    }
    return {
      type: entry.type,
      name: entry.name,
      tbl_name: entry.table,
      sql: entry.sql,
    };
  });
  let canonical: string;
  try {
    canonical = canonicalSchemaShape(rows);
  } catch {
    throw preflightError("D1 canonical schema shape is not canonically ordered");
  }
  if (canonical !== state.shape) {
    throw preflightError("D1 canonical schema shape is not canonically ordered");
  }
  return canonicalSchemaShape(rows.filter((row) => !isPlatformSchemaMetadata(row)));
}

function sameApplicationSchemaWithSqlTrivia(expectedShape: string, actualShape: string): boolean {
  let expected: unknown;
  let actual: unknown;
  try {
    expected = JSON.parse(expectedShape);
    actual = JSON.parse(actualShape);
  } catch {
    return false;
  }
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedRow = expected[index];
    const actualRow = actual[index];
    if (
      !isRecord(expectedRow) ||
      !isRecord(actualRow) ||
      expectedRow.type !== actualRow.type ||
      expectedRow.name !== actualRow.name ||
      expectedRow.table !== actualRow.table ||
      typeof expectedRow.sql !== "string" ||
      typeof actualRow.sql !== "string"
    ) {
      return false;
    }
    const expectedSql = normalizeSqlTrivia(expectedRow.sql);
    const actualSql = normalizeSqlTrivia(actualRow.sql);
    if (expectedSql === null || actualSql === null || expectedSql !== actualSql) return false;
  }
  return true;
}

/**
 * Removes only SQLite comments and ASCII whitespace outside SQL quotes. This
 * is deliberately local to generated-storage schema readback; raw shape
 * digests and migration/import evidence remain exact.
 */
function normalizeSqlTrivia(sql: string): string | null {
  let normalized = "";
  let pendingWhitespace = false;
  let index = 0;
  const append = (value: string): void => {
    if (pendingWhitespace && normalized.length > 0) normalized += " ";
    normalized += value;
    pendingWhitespace = false;
  };

  while (index < sql.length) {
    const character = sql[index];
    if (character === undefined) return null;
    if (isSqliteAsciiWhitespace(character)) {
      pendingWhitespace = true;
      index += 1;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      pendingWhitespace = true;
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) return null;
      pendingWhitespace = true;
      index = end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const start = index;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] !== character) {
          index += 1;
          continue;
        }
        if (sql[index + 1] === character) {
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      if (!closed) return null;
      append(sql.slice(start, index));
      continue;
    }
    if (character === "[") {
      const end = sql.indexOf("]", index + 1);
      if (end < 0) return null;
      append(sql.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    append(character);
    index += 1;
  }
  return normalized;
}

function isSqliteAsciiWhitespace(character: string): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r"
  );
}

function isPlatformSchemaMetadata(row: Record<string, unknown>): boolean {
  return (
    row.name === "d1_migrations" ||
    row.tbl_name === "d1_migrations" ||
    row.name === "_cf_KV" ||
    row.tbl_name === "_cf_KV"
  );
}

function digestShape(shape: string): string {
  return `sha256:${createHash("sha256").update(shape).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
