import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1 } from "./d1.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  type CommandResult,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import {
  type QualificationProcess,
  qualifySource,
  sealDirectory,
  unsealDirectory,
} from "./qualification.ts";

const SURFACE = "takoserver-d1-snapshot-restore";
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const DATABASE_NAME = /^takoserver-r-[0-9a-f]{32}$/u;
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const CREATE_TABLE =
  /^CREATE\s+(?:UNIQUE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z0-9_]+)/iu;
const CREATE_INDEX = /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu;
const CREATE_TRIGGER = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/iu;
const CREATE_VIEW = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?VIEW\b/iu;
const INSERT_INTO = /^INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO\s+["'`[]?([A-Za-z0-9_]+)/iu;
const UNVERIFIABLE_TABLE_WRITE =
  /^(?:UPDATE|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+TABLE|ALTER\s+TABLE)\s+["'`[]?([A-Za-z0-9_]+)/iu;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const MAX_MISMATCHES = 12;
const USER_TABLES_SQL =
  "SELECT name FROM sqlite_schema WHERE type = 'table' AND lower(name) NOT GLOB 'sqlite_*' " +
  "AND name <> '_cf_KV' AND name <> 'd1_migrations' ORDER BY name";
const LEDGER_TABLE_SQL = "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'd1_migrations'";
const LEDGER_ROWS_SQL = "SELECT COUNT(*) AS n FROM d1_migrations";
const LEDGER_LINEAGE_SQL = "SELECT name FROM d1_migrations ORDER BY id";
const SCHEMA_OBJECT_COUNTS_SQL =
  "SELECT type AS kind, COUNT(*) AS n FROM sqlite_schema " +
  "WHERE type IN ('index', 'trigger', 'view') AND lower(name) NOT GLOB 'sqlite_*' " +
  "AND name <> '_cf_KV' AND tbl_name <> '_cf_KV' " +
  "AND name <> 'd1_migrations' AND tbl_name <> 'd1_migrations' GROUP BY type";
const FOREIGN_KEY_CHECK_SQL = "PRAGMA foreign_key_check";

export interface D1SnapshotRestoreDeclaration {
  readonly kind: "takoserver.d1-snapshot-restore@v1";
  readonly environment: "rehearsal";
  readonly accountId: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly snapshotPath: string;
  readonly snapshotSha256: string;
}

export interface D1SnapshotRestoreInvocation {
  readonly action: "status" | "apply";
  readonly environment: "rehearsal";
  readonly commit: string;
}

export interface D1SnapshotRestoreOptions {
  readonly run?: QualificationProcess;
  readonly review?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly fetcher?: (request: Request) => Promise<Response>;
  readonly outputDirectory?: string;
}

export interface NormalizedSnapshot {
  readonly sql: string;
  readonly digest: string;
  readonly bytes: number;
  readonly nulBytes: number;
}

export interface SnapshotExpectations {
  readonly statements: number;
  readonly tables: readonly string[];
  readonly indexes: number;
  readonly triggers: number;
  readonly views: number;
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly migrationLineage: readonly string[];
}

export interface SnapshotRestoreReadback {
  readonly tables: readonly string[];
  readonly indexes: number;
  readonly triggers: number;
  readonly views: number;
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly migrationLineage: readonly string[];
  readonly foreignKeyViolations: number;
  readonly reportedQueries: number | null;
}

export interface SnapshotRestoreComparison {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

class SnapshotReadbackShapeError extends DeployError {}

function readbackPhaseError(phase: DeployPhase, message: string): SnapshotReadbackShapeError {
  return new SnapshotReadbackShapeError(
    phase === "preflight" ? "preflight" : "verification",
    message,
  );
}

/**
 * Rewrites every raw NUL byte that a `wrangler d1 export` dump carries inside a
 * TEXT literal as `'||char(0)||'`.
 *
 * D1's text SQL parser stops at the first NUL byte and `wrangler d1 execute
 * --file` still exits 0, so the measured production dump lost 4181 of its 4226
 * statements with no error. Normalization is semantics-preserving, and a NUL
 * outside a single-quoted literal is refused rather than rewritten.
 */
export function normalizeSnapshotDump(bytes: Uint8Array): NormalizedSnapshot {
  if (bytes.byteLength < 1) throw preflightError("snapshot dump is empty");
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    throw preflightError("snapshot dump exceeds the accepted size bound");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw preflightError("snapshot dump is not valid UTF-8");
  }
  const scanned = scanSnapshot(source);
  const normalized = new TextEncoder().encode(scanned.sql);
  return {
    sql: scanned.sql,
    digest: digestBytes(normalized),
    bytes: normalized.byteLength,
    nulBytes: scanned.nulBytes,
  };
}

/**
 * Derives the complete target state the normalized dump must produce: created
 * application tables and schema objects, per-table row counts implied by its
 * INSERT statements, and the exact `d1_migrations` lineage it carries.
 *
 * Anything this reader cannot count (an INSERT with no readable VALUES tuples,
 * an INSERT into a table the dump never creates, or a write to an application
 * table) is refused instead of being silently excluded, because a restore whose
 * completeness cannot be stated cannot be verified.
 */
export function deriveSnapshotExpectations(sql: string): SnapshotExpectations {
  const scanned = scanSnapshot(sql);
  const tables = new Set<string>();
  const rowCounts = new Map<string, number>();
  const migrationLineage: string[] = [];
  let statements = 0;
  let indexes = 0;
  let triggers = 0;
  let views = 0;
  for (const statement of scanned.statements) {
    const bare = bareStatement(statement);
    if (bare === "") continue;
    statements += 1;
    const createTable = CREATE_TABLE.exec(bare);
    if (createTable !== null) {
      const name = createTable[1] ?? "";
      if (!isPlatformObject(name)) tables.add(name);
      continue;
    }
    if (CREATE_INDEX.test(bare)) {
      indexes += 1;
      continue;
    }
    if (CREATE_TRIGGER.test(bare)) {
      triggers += 1;
      continue;
    }
    if (CREATE_VIEW.test(bare)) {
      views += 1;
      continue;
    }
    const insert = INSERT_INTO.exec(bare);
    if (insert !== null) {
      const name = insert[1] ?? "";
      const tuples = parseInsertValues(bare);
      if (tuples === null) {
        throw preflightError(
          "snapshot contains an INSERT this restore cannot count",
          `table=${name}`,
        );
      }
      if (isPlatformObject(name)) {
        if (name.toLowerCase() === "d1_migrations") {
          for (const tuple of tuples) {
            const migration = sqlLiteralValue(tuple[1]);
            if (migration === null) {
              throw preflightError("snapshot migration ledger row has no readable migration name");
            }
            migrationLineage.push(migration);
          }
        }
        continue;
      }
      if (!tables.has(name)) {
        throw preflightError("snapshot inserts into a table it does not create", `table=${name}`);
      }
      rowCounts.set(name, (rowCounts.get(name) ?? 0) + tuples.length);
      continue;
    }
    const write = UNVERIFIABLE_TABLE_WRITE.exec(bare);
    if (write !== null && !isPlatformObject(write[1] ?? "")) {
      throw preflightError(
        "snapshot contains a statement this restore cannot verify",
        `statement=${firstKeywords(bare)}`,
      );
    }
  }
  if (tables.size === 0) throw preflightError("snapshot dump creates no application table");
  const names = [...tables].sort();
  return {
    statements,
    tables: names,
    indexes,
    triggers,
    views,
    rowCounts: Object.fromEntries(names.map((name) => [name, rowCounts.get(name) ?? 0])),
    migrationLineage,
  };
}

/**
 * Compares one authoritative readback against the dump's own expectations. A
 * partial application is a mismatch list, never a success: every missing table,
 * row-count difference, schema-object difference, migration-lineage difference
 * and reported statement-count difference is reported.
 */
export function verifySnapshotRestore(
  expected: SnapshotExpectations,
  actual: SnapshotRestoreReadback,
): SnapshotRestoreComparison {
  const mismatches: string[] = [];
  const present = new Set(actual.tables);
  const wanted = new Set(expected.tables);
  for (const table of expected.tables) {
    if (!present.has(table)) mismatches.push(`missing table ${table}`);
  }
  for (const table of actual.tables) {
    if (!wanted.has(table)) mismatches.push(`unexpected table ${table}`);
  }
  if (actual.indexes !== expected.indexes) {
    mismatches.push(`index count: expected ${expected.indexes}, read back ${actual.indexes}`);
  }
  if (actual.triggers !== expected.triggers) {
    mismatches.push(`trigger count: expected ${expected.triggers}, read back ${actual.triggers}`);
  }
  if (actual.views !== expected.views) {
    mismatches.push(`view count: expected ${expected.views}, read back ${actual.views}`);
  }
  for (const table of expected.tables) {
    if (!present.has(table)) continue;
    const expectedRows = expected.rowCounts[table] ?? 0;
    const actualRows = actual.rowCounts[table];
    if (actualRows === undefined) {
      mismatches.push(`table ${table} row count was not read back`);
      continue;
    }
    if (actualRows !== expectedRows) {
      mismatches.push(`table ${table}: expected ${expectedRows} rows, read back ${actualRows}`);
    }
  }
  const lineageNamesDiffer = actual.migrationLineage.some(
    (name, index) => name !== expected.migrationLineage[index],
  );
  if (actual.migrationLineage.length !== expected.migrationLineage.length) {
    mismatches.push(
      "d1_migrations lineage: expected " +
        expected.migrationLineage.length +
        " entries, read back " +
        actual.migrationLineage.length,
    );
  } else if (lineageNamesDiffer) {
    mismatches.push("d1_migrations lineage entries differ");
  }
  if (actual.foreignKeyViolations !== 0) {
    mismatches.push(`foreign key violations: ${actual.foreignKeyViolations}`);
  }
  if (actual.reportedQueries !== null && actual.reportedQueries !== expected.statements) {
    mismatches.push(
      "applied statements: expected " +
        expected.statements +
        ", wrangler reported " +
        actual.reportedQueries,
    );
  }
  const bounded = mismatches.slice(0, MAX_MISMATCHES);
  if (mismatches.length > bounded.length) {
    bounded.push(`... and ${mismatches.length - bounded.length} more mismatches`);
  }
  return { ok: mismatches.length === 0, mismatches: bounded };
}

type ScanState = "code" | "single" | "double" | "bracket" | "lineComment" | "blockComment";

interface ScannedSnapshot {
  readonly sql: string;
  readonly statements: readonly string[];
  readonly nulBytes: number;
}

/**
 * One pass over a dump that normalizes NUL bytes and splits statements at
 * top-level semicolons. Quote and comment state is tracked with the same rules
 * SQLite uses, so a semicolon inside a literal never ends a statement.
 */
function scanSnapshot(source: string): ScannedSnapshot {
  const sql: string[] = [];
  const statements: string[] = [];
  const current: string[] = [];
  let state: ScanState = "code";
  let nulBytes = 0;
  const push = (value: string): void => {
    sql.push(value);
    current.push(value);
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = index + 1 < source.length ? (source[index + 1] ?? "") : "";
    if (character === "\u0000") {
      if (state !== "single") {
        throw preflightError(
          "snapshot dump contains a NUL byte outside a single-quoted literal",
          `offset=${index} state=${state}`,
        );
      }
      nulBytes += 1;
      push("'||char(0)||'");
      continue;
    }
    if (state === "code" && character === ";") {
      statements.push(current.join(""));
      current.length = 0;
      sql.push(";");
      continue;
    }
    push(character);
    if (state === "code") {
      if (character === "'") state = "single";
      else if (character === '"') state = "double";
      else if (character === "[") state = "bracket";
      else if (character === "-" && next === "-") {
        push(next);
        index += 1;
        state = "lineComment";
      } else if (character === "/" && next === "*") {
        push(next);
        index += 1;
        state = "blockComment";
      }
    } else if (state === "single") {
      if (character === "'") {
        if (next === "'") {
          push(next);
          index += 1;
        } else {
          state = "code";
        }
      }
    } else if (state === "double") {
      if (character === '"') {
        if (next === '"') {
          push(next);
          index += 1;
        } else {
          state = "code";
        }
      }
    } else if (state === "bracket") {
      if (character === "]") state = "code";
    } else if (state === "lineComment") {
      if (character === "\n") state = "code";
    } else if (state === "blockComment") {
      if (character === "*" && next === "/") {
        push(next);
        index += 1;
        state = "code";
      }
    }
  }
  if (current.join("").trim().length > 0) statements.push(current.join(""));
  return { sql: sql.join(""), statements, nulBytes };
}

/** Strips leading whitespace and comments so a statement can be classified. */
function bareStatement(statement: string): string {
  let remaining = statement.trim();
  for (;;) {
    if (remaining.startsWith("--")) {
      const end = remaining.indexOf("\n");
      remaining = (end === -1 ? "" : remaining.slice(end + 1)).trim();
      continue;
    }
    if (remaining.startsWith("/*")) {
      const end = remaining.indexOf("*/");
      remaining = (end === -1 ? "" : remaining.slice(end + 2)).trim();
      continue;
    }
    return remaining;
  }
}

function firstKeywords(statement: string): string {
  return statement.split(/\s+/u).slice(0, 3).join(" ");
}

function isPlatformObject(name: string): boolean {
  return name === "d1_migrations" || name === "_cf_KV" || name.toLowerCase().startsWith("sqlite_");
}

/**
 * Reads the VALUES tuples of one INSERT statement, or null when the statement
 * cannot be counted exactly (SELECT source, no VALUES keyword, or trailing
 * clauses such as ON CONFLICT). Each tuple is split on its own top-level
 * commas.
 */
function parseInsertValues(statement: string): readonly (readonly string[])[] | null {
  let state: "code" | "single" | "double" | "bracket" = "code";
  let depth = 0;
  let valuesStart = -1;
  for (let index = 0; index < statement.length; index += 1) {
    const character = statement[index] ?? "";
    const next = index + 1 < statement.length ? (statement[index + 1] ?? "") : "";
    if (state === "code") {
      if (character === "'") state = "single";
      else if (character === '"') state = "double";
      else if (character === "[") state = "bracket";
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (depth === 0 && (character === "v" || character === "V")) {
        const before = index === 0 ? "" : (statement[index - 1] ?? "");
        const after = statement[index + 6] ?? "";
        if (
          statement.slice(index, index + 6).toLowerCase() === "values" &&
          !/[A-Za-z0-9_$]/u.test(before) &&
          !/[A-Za-z0-9_$]/u.test(after)
        ) {
          valuesStart = index + 6;
          break;
        }
      }
    } else if (state === "single") {
      if (character === "'") {
        if (next === "'") index += 1;
        else state = "code";
      }
    } else if (state === "double") {
      if (character === '"') {
        if (next === '"') index += 1;
        else state = "code";
      }
    } else if (character === "]") {
      state = "code";
    }
  }
  if (valuesStart === -1) return null;
  const tuples: (readonly string[])[] = [];
  let index = valuesStart;
  let opened = false;
  for (;;) {
    while (index < statement.length) {
      const character = statement[index] ?? "";
      if (character === "(") break;
      if (character === ")" || character === ";" || /[A-Za-z0-9_$"']/u.test(character)) return null;
      index += 1;
    }
    if (index >= statement.length) break;
    const tuple = readParenthesized(statement, index);
    if (tuple === null) return null;
    tuples.push(tuple.values);
    index = tuple.end;
    opened = true;
  }
  return opened ? tuples : null;
}

/** Reads one balanced parenthesized group, keeping quote state across it. */
function readParenthesized(
  statement: string,
  start: number,
): { readonly values: readonly string[]; readonly end: number } | null {
  let state: "code" | "single" | "double" | "bracket" = "code";
  let depth = 0;
  let body = "";
  for (let index = start; index < statement.length; index += 1) {
    const character = statement[index] ?? "";
    const next = index + 1 < statement.length ? (statement[index + 1] ?? "") : "";
    if (state === "code") {
      if (character === "'") {
        state = "single";
        body += character;
      } else if (character === '"') {
        state = "double";
        body += character;
      } else if (character === "[") {
        state = "bracket";
        body += character;
      } else if (character === "(") {
        depth += 1;
        if (depth > 1) body += character;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          return { values: splitTopLevel(body), end: index + 1 };
        }
        body += character;
      } else {
        body += character;
      }
    } else if (state === "single") {
      body += character;
      if (character === "'") {
        if (next === "'") {
          body += next;
          index += 1;
        } else {
          state = "code";
        }
      }
    } else if (state === "double") {
      body += character;
      if (character === '"') {
        if (next === '"') {
          body += next;
          index += 1;
        } else {
          state = "code";
        }
      }
    } else {
      body += character;
      if (character === "]") state = "code";
    }
  }
  return null;
}

function splitTopLevel(body: string): readonly string[] {
  const values: string[] = [];
  let state: "code" | "single" | "double" | "bracket" = "code";
  let depth = 0;
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? "";
    const next = index + 1 < body.length ? (body[index + 1] ?? "") : "";
    if (state === "code") {
      if (character === "'") {
        state = "single";
        current += character;
      } else if (character === '"') {
        state = "double";
        current += character;
      } else if (character === "[") {
        state = "bracket";
        current += character;
      } else if (character === "(") {
        depth += 1;
        current += character;
      } else if (character === ")") {
        depth -= 1;
        current += character;
      } else if (character === "," && depth === 0) {
        values.push(current);
        current = "";
      } else {
        current += character;
      }
    } else if (state === "single") {
      current += character;
      if (character === "'") {
        if (next === "'") {
          current += next;
          index += 1;
        } else {
          state = "code";
        }
      }
    } else if (state === "double") {
      current += character;
      if (character === '"') {
        if (next === '"') {
          current += next;
          index += 1;
        } else {
          state = "code";
        }
      }
    } else {
      current += character;
      if (character === "]") state = "code";
    }
  }
  values.push(current);
  return values;
}

/** Reads one single-quoted SQL literal, or null when the text is not one. */
function sqlLiteralValue(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("'") || !trimmed.endsWith("'")) return null;
  const inner = trimmed.slice(1, -1);
  const withoutEscapes = inner.replaceAll("''", "");
  if (withoutEscapes.includes("'")) return null;
  return inner.replaceAll("''", "'");
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

interface TargetState {
  readonly userTables: readonly string[];
  readonly migrationRows: number;
  readonly migrationLineage: readonly string[];
  readonly indexes: number;
  readonly triggers: number;
  readonly views: number;
}

async function readExactStringRows(
  database: RemoteD1,
  phase: DeployPhase,
  description: string,
  sql: string,
  column: string,
): Promise<readonly string[]> {
  const rows = await database.query(phase, description, sql);
  const values: string[] = [];
  for (const row of rows) {
    if (Object.keys(row).length !== 1 || typeof row[column] !== "string") {
      throw readbackPhaseError(phase, `${description} returned a malformed row`);
    }
    values.push(row[column] as string);
  }
  return values;
}

function readExactCountResult(
  rows: readonly Record<string, unknown>[],
  phase: DeployPhase,
  description: string,
  maximum?: number,
): number {
  if (rows.length !== 1) {
    throw readbackPhaseError(phase, `${description} returned an unexpected row`);
  }
  const row = rows[0] ?? {};
  const count = row.n;
  if (
    Object.keys(row).length !== 1 ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    (maximum !== undefined && count > maximum)
  ) {
    throw readbackPhaseError(phase, `${description} returned a malformed count`);
  }
  return count;
}

async function readTargetState(database: RemoteD1, phase: DeployPhase): Promise<TargetState> {
  const userTables = await readExactStringRows(
    database,
    phase,
    "snapshot restore target tables",
    USER_TABLES_SQL,
    "name",
  );
  if (new Set(userTables).size !== userTables.length) {
    throw readbackPhaseError(phase, "snapshot restore target tables returned duplicate names");
  }
  const schemaObjects = await database.query(
    phase,
    "snapshot restore target schema objects",
    SCHEMA_OBJECT_COUNTS_SQL,
  );
  const schemaObjectKinds = new Set(["index", "trigger", "view"]);
  const observedSchemaObjectKinds = new Set<string>();
  for (const row of schemaObjects) {
    const kind = row.kind;
    const count = row.n;
    if (
      Object.keys(row).length !== 2 ||
      typeof kind !== "string" ||
      !schemaObjectKinds.has(kind) ||
      observedSchemaObjectKinds.has(kind) ||
      !Number.isSafeInteger(count) ||
      Number(count) < 1
    ) {
      throw readbackPhaseError(
        phase,
        "snapshot restore target schema-object readback is malformed",
      );
    }
    observedSchemaObjectKinds.add(kind);
  }
  const schemaObjectCount = (kind: string): number => {
    const row = schemaObjects.find((entry) => entry.kind === kind);
    if (row === undefined) return 0;
    return Number(row.n);
  };
  const indexes = schemaObjectCount("index");
  const triggers = schemaObjectCount("trigger");
  const views = schemaObjectCount("view");
  const ledger = await database.query(
    phase,
    "snapshot restore target migration ledger",
    LEDGER_TABLE_SQL,
  );
  const ledgerCount = readExactCountResult(
    ledger,
    phase,
    "snapshot restore target migration ledger",
    1,
  );
  const ledgerPresent = ledgerCount === 1;
  let migrationRows = 0;
  let migrationLineage: readonly string[] = [];
  if (ledgerPresent) {
    const rows = await database.query(
      phase,
      "snapshot restore target migration rows",
      LEDGER_ROWS_SQL,
    );
    migrationRows = readExactCountResult(rows, phase, "snapshot restore target migration rows");
    migrationLineage = await readExactStringRows(
      database,
      phase,
      "snapshot restore target migration lineage",
      LEDGER_LINEAGE_SQL,
      "name",
    );
    if (migrationLineage.length !== migrationRows) {
      throw readbackPhaseError(
        phase,
        "snapshot restore target migration lineage count does not match its ledger count",
      );
    }
  }
  return { userTables, migrationRows, migrationLineage, indexes, triggers, views };
}

async function readRestoreReadback(
  database: RemoteD1,
  expected: SnapshotExpectations,
  phase: DeployPhase,
  reportedQueries: number | null,
): Promise<SnapshotRestoreReadback> {
  const tables = await readExactStringRows(
    database,
    phase,
    "snapshot restore readback tables",
    USER_TABLES_SQL,
    "name",
  );
  if (new Set(tables).size !== tables.length) {
    throw readbackPhaseError(phase, "snapshot restore readback tables returned duplicate names");
  }
  const present = expected.tables.filter((table) => tables.includes(table));
  const rowCounts: Record<string, number> = {};
  if (present.length > 0) {
    const sql =
      "SELECT " +
      present.map((table) => `(SELECT COUNT(*) FROM "${table}") AS "${table}"`).join(", ");
    const rows = await database.query(phase, "snapshot restore readback row counts", sql);
    if (rows.length !== 1) {
      throw readbackPhaseError(
        phase,
        "snapshot restore readback row counts returned an unexpected row",
      );
    }
    const row = rows[0] ?? {};
    const expectedAliases = new Set(present);
    if (
      Object.keys(row).length !== expectedAliases.size ||
      Object.keys(row).some((alias) => !expectedAliases.has(alias))
    ) {
      throw readbackPhaseError(
        phase,
        "snapshot restore readback row counts returned a malformed row",
      );
    }
    for (const table of present) {
      const value = row[table];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw readbackPhaseError(
          phase,
          "snapshot restore readback row counts returned a malformed count",
        );
      }
      rowCounts[table] = value;
    }
  }
  const target = await readTargetState(database, phase);
  const violations = await database.query(
    phase,
    "snapshot restore readback foreign key check",
    FOREIGN_KEY_CHECK_SQL,
  );
  return {
    tables,
    indexes: target.indexes,
    triggers: target.triggers,
    views: target.views,
    rowCounts,
    migrationLineage: target.migrationLineage,
    foreignKeyViolations: violations.length,
    reportedQueries,
  };
}

function reportedQueryCount(stdout: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return null;
  const block = parsed[0];
  if (typeof block !== "object" || block === null || Array.isArray(block)) return null;
  const results = (block as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length !== 1) return null;
  const row = results[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const value = (row as Record<string, unknown>)["Total queries executed"];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readSnapshotFile(path: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw preflightError("snapshot dump could not be opened");
  }
  try {
    const status = fstatSync(fd);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      status.uid !== process.getuid?.() ||
      (status.mode & 0o077) !== 0
    ) {
      throw preflightError(
        "snapshot dump must be an owned single-link regular file with no group or other access",
        "chmod 600 the dump before restoring it",
      );
    }
    if (status.size < 1 || status.size > MAX_SNAPSHOT_BYTES) {
      throw preflightError("snapshot dump size is outside the accepted bound");
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function wranglerConfig(declaration: D1SnapshotRestoreDeclaration): string {
  return `${JSON.stringify(
    {
      name: "takoserver-d1-snapshot-restore",
      account_id: declaration.accountId,
      compatibility_date: "2026-08-17",
      d1_databases: [
        {
          binding: "STATE_DB",
          database_name: declaration.databaseName,
          database_id: declaration.databaseId,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function exactReviewer(value: string): string {
  const reviewer = value.trim();
  if (reviewer.length < 1 || reviewer.length > 240 || reviewer.includes("\n")) {
    throw preflightError("independent review reference must be one exact non-empty line");
  }
  return reviewer;
}

/**
 * Restores one exported D1 dump into one declared, empty rehearsal-generation
 * D1 and proves the result against the dump's own expectations.
 *
 * The surface never adopts an existing target: it refuses any target that
 * already carries application tables or a migration ledger. The normalization
 * and the post-import completeness readback exist because the measured
 * export/import path reported success after applying 45 of 4226 statements.
 */
export async function runD1SnapshotRestore(
  declaration: D1SnapshotRestoreDeclaration,
  invocation: D1SnapshotRestoreInvocation,
  options: D1SnapshotRestoreOptions = {},
): Promise<Record<string, unknown>> {
  validateDeclaration(declaration);
  if (invocation.environment !== "rehearsal") {
    throw preflightError("snapshot restore accepts only the rehearsal environment");
  }
  if (!COMMIT.test(invocation.commit)) {
    throw preflightError("--commit must be one exact lowercase 40-hex commit");
  }
  const snapshot = readSnapshotFile(declaration.snapshotPath);
  const snapshotDigest = digestBytes(snapshot);
  if (snapshotDigest !== declaration.snapshotSha256) {
    throw preflightError(
      "snapshot dump bytes do not match the declared sha256",
      `declared=${declaration.snapshotSha256} read=${snapshotDigest}`,
    );
  }
  const normalized = normalizeSnapshotDump(snapshot);
  const expected = deriveSnapshotExpectations(normalized.sql);
  const expectedRows = Object.values(expected.rowCounts).reduce((total, rows) => total + rows, 0);
  const run = options.run ?? runCommand;
  const credential = await resolveCloudflareCredential("rehearsal", {
    ...(options.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: options.cloudflareEnvironment }),
    run,
  });
  if (credential.source !== "api-token") {
    throw preflightError("snapshot restore requires an explicit CLOUDFLARE_API_TOKEN");
  }
  const environment = credential.childEnvironment;
  const provider = new CloudflareState({
    accountId: declaration.accountId,
    token: credential.token,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  const assertProviderIdentity = async (stage: string): Promise<void> => {
    const result = await provider.read(
      `/d1/database/${encodeURIComponent(declaration.databaseId)}`,
      `snapshot restore D1 identity ${stage}`,
    );
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result) ||
      (result as { uuid?: unknown }).uuid !== declaration.databaseId ||
      (result as { name?: unknown }).name !== declaration.databaseName
    ) {
      throw preflightError(
        "snapshot restore provider identity does not match the declared UUID and name",
      );
    }
  };
  await assertProviderIdentity("before inspection");

  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-d1-snapshot-restore-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let targetMayHaveChanged = false;
  try {
    const normalizedPath = join(root, "snapshot-normalized.sql");
    writeFileSync(normalizedPath, normalized.sql, { flag: "wx", mode: 0o600 });
    const configPath = join(root, "wrangler.jsonc");
    writeFileSync(configPath, wranglerConfig(declaration), { flag: "wx", mode: 0o600 });
    const sealed = sealDirectory(root, ["snapshot-normalized.sql", "wrangler.jsonc"]);
    const database = new RemoteD1(configPath, { environment, run });
    const target = await readTargetState(database, "preflight");
    const empty = isEmptyTarget(target);

    if (invocation.action === "status") {
      const currentReadback = empty
        ? null
        : await readRestoreReadback(database, expected, "preflight", null);
      const currentComparison =
        currentReadback === null ? null : verifySnapshotRestore(expected, currentReadback);
      return {
        kind: "takoserver.d1-snapshot-restore-status@v1",
        surface: SURFACE,
        environment: "rehearsal",
        selectedCommit: invocation.commit,
        accountId: declaration.accountId,
        databaseId: declaration.databaseId,
        databaseName: declaration.databaseName,
        providerIdentityVerified: true,
        snapshotSha256: declaration.snapshotSha256,
        snapshotBytes: snapshot.byteLength,
        normalizedBytes: normalized.bytes,
        nulBytesRewritten: normalized.nulBytes,
        expectedStatements: expected.statements,
        expectedTables: expected.tables.length,
        expectedTableNames: expected.tables,
        expectedRows,
        expectedRowsByTable: expected.rowCounts,
        expectedIndexes: expected.indexes,
        expectedTriggers: expected.triggers,
        expectedViews: expected.views,
        expectedMigrationLineage: expected.migrationLineage.length,
        expectedMigrationLineageNames: expected.migrationLineage,
        targetTables: target.userTables.length,
        targetMigrationRows: target.migrationRows,
        targetIndexes: target.indexes,
        targetTriggers: target.triggers,
        targetViews: target.views,
        currentTables: currentReadback?.tables ?? null,
        currentRowsByTable: currentReadback?.rowCounts ?? null,
        currentIndexes: currentReadback?.indexes ?? null,
        currentTriggers: currentReadback?.triggers ?? null,
        currentViews: currentReadback?.views ?? null,
        currentMigrationLineageNames: currentReadback?.migrationLineage ?? null,
        currentForeignKeyViolations: currentReadback?.foreignKeyViolations ?? null,
        currentSnapshotExpectationMatch: currentComparison?.ok ?? null,
        currentSnapshotExpectationMismatches: currentComparison?.mismatches ?? [],
        readyForApply: empty,
      };
    }

    if (!empty) {
      throw preflightError(
        "snapshot restore target already carries tables or a migration ledger; this surface never resets or overwrites a D1",
        targetStateDiagnostic(target),
      );
    }
    const reviewer = exactReviewer(
      options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
    );
    const source = await qualifySource({
      environment: "rehearsal",
      commit: invocation.commit,
      policy: "clean-remote",
      ...(options.run === undefined ? {} : { run: options.run }),
    });
    const refence = await readTargetState(database, "preflight");
    if (!isEmptyTarget(refence)) {
      throw preflightError("snapshot restore target changed before the import; refusing to import");
    }
    await assertProviderIdentity("at restore fence");
    sealed.assertUnchanged();

    targetMayHaveChanged = true;
    let imported: CommandResult | null = null;
    try {
      imported = await run(
        wranglerCommand([
          "d1",
          "execute",
          declaration.databaseName,
          "--remote",
          "--yes",
          "--config",
          configPath,
          "--json",
          "--file",
          normalizedPath,
        ]),
        { env: environment },
      );
    } catch {
      // An unknown acknowledgement is never a retry signal.
    }
    const reportedQueries = imported === null ? null : reportedQueryCount(imported.stdout);
    let readback: SnapshotRestoreReadback;
    try {
      readback = await readRestoreReadback(database, expected, "verification", reportedQueries);
    } catch (error) {
      if (
        imported !== null &&
        imported.exitCode === 0 &&
        error instanceof SnapshotReadbackShapeError &&
        error.phase === "verification"
      ) {
        throw error;
      }
      throw mutationError(
        "snapshot restore import acknowledgement/readback is indeterminate; inspect the target and do not replay",
      );
    }
    if (imported === null || imported.exitCode !== 0) {
      throw mutationError(
        "snapshot restore import acknowledgement is indeterminate; inspect the target and do not replay",
        JSON.stringify({
          exitCode: imported?.exitCode ?? null,
          tablesReadBack: readback.tables.length,
        }),
      );
    }
    const comparison = verifySnapshotRestore(expected, readback);
    if (!comparison.ok) {
      throw verificationError(
        "snapshot restore is incomplete or inexact; a partial application is never reported as success",
        comparison.mismatches.join("; "),
      );
    }
    return {
      kind: "takoserver.d1-snapshot-restore-apply@v1",
      surface: SURFACE,
      environment: "rehearsal",
      commit: source.commit,
      remoteRef: source.remoteRef,
      reviewer,
      accountId: declaration.accountId,
      databaseId: declaration.databaseId,
      databaseName: declaration.databaseName,
      providerIdentityVerified: true,
      snapshotSha256: declaration.snapshotSha256,
      snapshotBytes: snapshot.byteLength,
      normalizedBytes: normalized.bytes,
      normalizedSha256: normalized.digest,
      nulBytesRewritten: normalized.nulBytes,
      statements: expected.statements,
      reportedQueries: readback.reportedQueries,
      tables: expected.tables.length,
      rows: expectedRows,
      indexes: expected.indexes,
      triggers: expected.triggers,
      views: expected.views,
      migrationLineage: expected.migrationLineage.length,
      foreignKeyViolations: readback.foreignKeyViolations,
      recovery:
        "leave the restored D1 intact and repair forward; this surface never deletes or resets it",
    };
  } catch (error) {
    if (!targetMayHaveChanged) throw error;
    if (error instanceof DeployError && error.phase !== "preflight") throw error;
    throw mutationError(
      "snapshot restore may have changed the target; inspect authoritative status and do not replay",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    unsealDirectory(root);
    if (temporary) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Local temporary cleanup must not replace the D1 mutation outcome.
      }
    }
  }
}

function isEmptyTarget(target: TargetState): boolean {
  return (
    target.userTables.length === 0 &&
    target.migrationRows === 0 &&
    target.indexes === 0 &&
    target.triggers === 0 &&
    target.views === 0
  );
}

function targetStateDiagnostic(target: TargetState): string {
  return [
    `tables=${target.userTables.join(",")}`,
    `migrationRows=${target.migrationRows}`,
    `indexes=${target.indexes}`,
    `triggers=${target.triggers}`,
    `views=${target.views}`,
  ].join(" ");
}

function validateDeclaration(value: D1SnapshotRestoreDeclaration): void {
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !==
      "accountId,databaseId,databaseName,environment,kind,snapshotPath,snapshotSha256" ||
    value.kind !== "takoserver.d1-snapshot-restore@v1" ||
    value.environment !== "rehearsal" ||
    !ACCOUNT_ID.test(value.accountId) ||
    !DATABASE_NAME.test(value.databaseName) ||
    !DATABASE_ID.test(value.databaseId) ||
    !SHA256.test(value.snapshotSha256) ||
    typeof value.snapshotPath !== "string" ||
    !isAbsolute(value.snapshotPath) ||
    /[\0\r\n]/u.test(value.snapshotPath)
  ) {
    throw preflightError(
      "snapshot restore declaration must name one rehearsal-generation D1 and one absolute snapshot path",
    );
  }
}
