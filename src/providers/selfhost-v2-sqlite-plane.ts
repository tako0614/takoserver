import { Buffer } from "node:buffer";
import { type DatabaseSync, type SQLInputValue, constants as SQLITE } from "node:sqlite";
import { canonicalJson } from "../json.ts";

const MAX_SQL_BYTES = 100_000;
const MAX_PARAMETERS = 100;
const MAX_STATEMENTS = 100;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 100;
const MAX_SQL_VALUE_BYTES = 1_000_000;
const MAX_COLUMN_NAME_BYTES = 128;
const MAX_ROW_BYTES = 2_000_000;
const MAX_OUTPUT_BYTES = 8_388_608;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const UTF8 = new TextEncoder();

export type EdgeSqlValue = null | number | string | Readonly<{ encoding: "base64"; data: string }>;

export type EdgeSqlRow = Readonly<Record<string, EdgeSqlValue>>;

export type SelfhostV2SqliteResult = Readonly<{
  rows: readonly EdgeSqlRow[];
  rowsWritten: number;
}>;

export type SelfhostV2SqliteStatement = Readonly<{
  sql: string;
  params?: readonly EdgeSqlValue[];
}>;

type BoundStatement = Readonly<{ sql: string; params: readonly SQLInputValue[] }>;
type OutputBudget = { serializedRowsBytes: number };

export interface SelfhostV2SqlitePlaneOptions {
  /**
   * The Host-selected connection for one authorized Resource. Ownership is
   * transferred to this plane because its authorizer is connection-wide.
   */
  readonly database: DatabaseSync;
  /** The exact Host-owned schema/table that stores migration history. */
  readonly migrationLedger: Readonly<{ schema: string; table: string }>;
}

export interface SelfhostV2SqlitePlane {
  execute(sql: string, params?: readonly EdgeSqlValue[]): Promise<SelfhostV2SqliteResult>;
  query(
    sql: string,
    params?: readonly EdgeSqlValue[],
  ): Promise<SelfhostV2SqliteResult & { rowsWritten: 0 }>;
  transaction(
    statements: readonly SelfhostV2SqliteStatement[],
  ): Promise<Readonly<{ results: readonly SelfhostV2SqliteResult[] }>>;
  /** Closes the injected Host-selected connection; it never removes its file. */
  close(): void;
}

export type SelfhostV2SqliteErrorCode =
  | "sql_error"
  | "numeric_out_of_range"
  | "busy"
  | "backend_unavailable";

export class SelfhostV2SqliteError extends Error {
  constructor(readonly code: SelfhostV2SqliteErrorCode) {
    super(code);
    this.name = code;
  }
}

const DENIED_ACTIONS = new Set<number>([
  SQLITE.SQLITE_CREATE_INDEX,
  SQLITE.SQLITE_CREATE_TABLE,
  SQLITE.SQLITE_CREATE_TEMP_INDEX,
  SQLITE.SQLITE_CREATE_TEMP_TABLE,
  SQLITE.SQLITE_CREATE_TEMP_TRIGGER,
  SQLITE.SQLITE_CREATE_TEMP_VIEW,
  SQLITE.SQLITE_CREATE_TRIGGER,
  SQLITE.SQLITE_CREATE_VIEW,
  SQLITE.SQLITE_DROP_INDEX,
  SQLITE.SQLITE_DROP_TABLE,
  SQLITE.SQLITE_DROP_TEMP_INDEX,
  SQLITE.SQLITE_DROP_TEMP_TABLE,
  SQLITE.SQLITE_DROP_TEMP_TRIGGER,
  SQLITE.SQLITE_DROP_TEMP_VIEW,
  SQLITE.SQLITE_DROP_TRIGGER,
  SQLITE.SQLITE_DROP_VIEW,
  SQLITE.SQLITE_PRAGMA,
  SQLITE.SQLITE_TRANSACTION,
  SQLITE.SQLITE_ATTACH,
  SQLITE.SQLITE_DETACH,
  SQLITE.SQLITE_ALTER_TABLE,
  SQLITE.SQLITE_REINDEX,
  SQLITE.SQLITE_ANALYZE,
  SQLITE.SQLITE_CREATE_VTABLE,
  SQLITE.SQLITE_DROP_VTABLE,
  SQLITE.SQLITE_SAVEPOINT,
  SQLITE.SQLITE_COPY,
]);

const SCHEMA_TABLES = new Set([
  "sqlite_master",
  "sqlite_schema",
  "sqlite_temp_master",
  "sqlite_temp_schema",
]);

/**
 * Host-only SQLite access for one v2 Worker binding.
 *
 * The caller chooses and injects the already-authorized connection and exact
 * migration ledger identity. This plane owns neither database discovery nor
 * Resource lifecycle; closing it closes only that injected connection.
 */
export function createSelfhostV2SqlitePlane(
  options: SelfhostV2SqlitePlaneOptions,
): SelfhostV2SqlitePlane {
  const database = options?.database;
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.exec !== "function" ||
    typeof database.setAuthorizer !== "function" ||
    typeof database.close !== "function" ||
    database.isOpen !== true ||
    database.isTransaction
  ) {
    throw new TypeError(
      "an open Host-selected SQLite connection outside a transaction is required",
    );
  }
  const ledger = options.migrationLedger;
  const ledgerSchemaValue = ledger?.schema;
  const ledgerTableValue = ledger?.table;
  if (
    ledgerSchemaValue !== "main" ||
    typeof ledgerTableValue !== "string" ||
    ledgerTableValue.length === 0 ||
    ledgerTableValue.includes("\u0000")
  ) {
    throw new TypeError("the exact Host migration ledger identity is required");
  }

  const ledgerSchema = asciiLower(ledgerSchemaValue);
  const ledgerTable = asciiLower(ledgerTableValue);
  let closed = false;
  let internalTransactionControl = false;
  let statementHasWriteAction = false;

  const authorizer = (
    action: number,
    first: string | null,
    second: string | null,
    schema: string | null,
  ): number => {
    if (
      action === SQLITE.SQLITE_INSERT ||
      action === SQLITE.SQLITE_UPDATE ||
      action === SQLITE.SQLITE_DELETE
    ) {
      statementHasWriteAction = true;
    }
    if (
      internalTransactionControl &&
      (action === SQLITE.SQLITE_TRANSACTION || action === SQLITE.SQLITE_SAVEPOINT)
    ) {
      return SQLITE.SQLITE_OK;
    }
    if (DENIED_ACTIONS.has(action)) return SQLITE.SQLITE_DENY;
    if (action === SQLITE.SQLITE_FUNCTION && asciiLower(second ?? "") === "load_extension") {
      return SQLITE.SQLITE_DENY;
    }
    if (
      action === SQLITE.SQLITE_READ ||
      action === SQLITE.SQLITE_INSERT ||
      action === SQLITE.SQLITE_UPDATE ||
      action === SQLITE.SQLITE_DELETE
    ) {
      const table = asciiLower(first ?? "");
      const sqliteSchema = asciiLower(schema ?? "");
      if (sqliteSchema !== "" && sqliteSchema !== "main") return SQLITE.SQLITE_DENY;
      if (
        SCHEMA_TABLES.has(table) ||
        ((sqliteSchema === "" || sqliteSchema === ledgerSchema) && table === ledgerTable)
      ) {
        return SQLITE.SQLITE_DENY;
      }
      return SQLITE.SQLITE_OK;
    }
    return action === SQLITE.SQLITE_SELECT ||
      action === SQLITE.SQLITE_FUNCTION ||
      action === SQLITE.SQLITE_RECURSIVE
      ? SQLITE.SQLITE_OK
      : SQLITE.SQLITE_DENY;
  };

  database.setAuthorizer(authorizer);

  const assertOpen = (): void => {
    if (closed || !database.isOpen) throw new SelfhostV2SqliteError("backend_unavailable");
  };

  const internalExec = (sql: "BEGIN IMMEDIATE" | "COMMIT" | "ROLLBACK"): void => {
    internalTransactionControl = true;
    try {
      database.exec(sql);
    } finally {
      internalTransactionControl = false;
    }
  };

  const withTransaction = <T>(commit: boolean, run: () => T): T => {
    assertOpen();
    let started = false;
    try {
      // VACUUM has no authorizer action; SQLite's parser rejects it while this
      // required transaction is active, without inspecting SQL keywords here.
      internalExec("BEGIN IMMEDIATE");
      started = true;
      const result = run();
      if (commit) {
        internalExec("COMMIT");
        started = false;
      } else {
        internalExec("ROLLBACK");
        started = false;
      }
      return result;
    } catch (error) {
      if (started && database.isOpen && database.isTransaction) {
        try {
          internalExec("ROLLBACK");
        } catch {
          closed = true;
          try {
            database.close();
          } catch {
            // Closing is the final fence if SQLite could not roll back.
          }
          throw new SelfhostV2SqliteError("backend_unavailable");
        }
      }
      throw normalizeSqliteError(error, database.isOpen);
    }
  };

  const runStatement = (
    statementInput: BoundStatement,
    rowsWrittenMode: "changes" | "zero",
    outputBudget: OutputBudget,
  ): SelfhostV2SqliteResult => {
    assertOpen();
    assertSingleStatement(statementInput.sql);
    statementHasWriteAction = false;
    const statement = database.prepare(statementInput.sql);
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const columns = statement.columns();
    if (columns.length > MAX_COLUMNS) throw new SelfhostV2SqliteError("sql_error");
    const names = columns.map((column) => {
      if (utf8Bytes(column.name) > MAX_COLUMN_NAME_BYTES) {
        throw new SelfhostV2SqliteError("sql_error");
      }
      return column.name;
    });
    if (new Set(names).size !== names.length) throw new SelfhostV2SqliteError("sql_error");
    const rows: EdgeSqlRow[] = [];
    const iterator = statement.iterate(...(statementInput.params ?? [])) as unknown as Iterator<
      readonly unknown[]
    >;
    try {
      for (;;) {
        const next = iterator.next();
        if (next.done) break;
        if (rows.length >= MAX_ROWS) throw new SelfhostV2SqliteError("sql_error");
        const values = next.value;
        if (!Array.isArray(values) || values.length !== names.length) {
          throw new SelfhostV2SqliteError("sql_error");
        }
        const row = Object.create(null) as Record<string, EdgeSqlValue>;
        for (let index = 0; index < names.length; index += 1) {
          const name = names[index];
          if (name === undefined) throw new SelfhostV2SqliteError("sql_error");
          row[name] = encodeOutput(values[index]);
        }
        const rowBytes = utf8Bytes(canonicalJson(row));
        if (rowBytes > MAX_ROW_BYTES) {
          throw new SelfhostV2SqliteError("sql_error");
        }
        outputBudget.serializedRowsBytes += rowBytes + (rows.length > 0 ? 1 : 0);
        if (outputBudget.serializedRowsBytes > MAX_OUTPUT_BYTES) {
          throw new SelfhostV2SqliteError("sql_error");
        }
        rows.push(Object.freeze(row));
      }
    } finally {
      iterator.return?.();
    }

    const rowsWritten =
      rowsWrittenMode === "zero" || !statementHasWriteAction ? 0 : changesWritten(database);
    return Object.freeze({ rows: Object.freeze(rows), rowsWritten });
  };

  const checkEnvelope = <T>(value: T): T => {
    if (utf8Bytes(canonicalJson(value)) > MAX_OUTPUT_BYTES) {
      throw new SelfhostV2SqliteError("sql_error");
    }
    return value;
  };

  const plane: SelfhostV2SqlitePlane = {
    async execute(...args: unknown[]): Promise<SelfhostV2SqliteResult> {
      if (args.length > 2) throw new TypeError("execute accepts only SQL and params");
      const input = snapshotStatement({
        sql: args[0],
        params: args[1] === undefined ? [] : args[1],
      });
      const outputBudget = { serializedRowsBytes: 0 };
      return withTransaction(true, () => {
        const result = runStatement(input, "changes", outputBudget);
        return checkEnvelope(result);
      });
    },

    async query(...args: unknown[]): Promise<SelfhostV2SqliteResult & { rowsWritten: 0 }> {
      if (args.length > 2) throw new TypeError("query accepts only SQL and params");
      const input = snapshotStatement({
        sql: args[0],
        params: args[1] === undefined ? [] : args[1],
      });
      const outputBudget = { serializedRowsBytes: 0 };
      return withTransaction(false, () => {
        const result = runStatement(input, "zero", outputBudget) as SelfhostV2SqliteResult & {
          rowsWritten: 0;
        };
        return checkEnvelope(result);
      });
    },

    async transaction(
      ...args: unknown[]
    ): Promise<Readonly<{ results: readonly SelfhostV2SqliteResult[] }>> {
      if (args.length > 1) throw new TypeError("transaction accepts only a statement list");
      const input = snapshotTransaction(args[0]);
      const outputBudget = { serializedRowsBytes: 0 };
      return withTransaction(true, () => {
        const results = input.map((statement) => runStatement(statement, "changes", outputBudget));
        return checkEnvelope(Object.freeze({ results: Object.freeze(results) }));
      });
    },

    close(...args: unknown[]): void {
      if (args.length > 0) throw new TypeError("close accepts no arguments");
      if (closed) return;
      closed = true;
      if (database.isOpen) database.close();
    },
  };
  return Object.freeze(plane);
}

function snapshotTransaction(value: unknown): BoundStatement[] {
  const statements = arrayValues(value, MAX_STATEMENTS);
  if (statements.length < 1 || statements.length > MAX_STATEMENTS) {
    throw new TypeError("transaction must contain between 1 and 100 statements");
  }
  return statements.map((statement) => {
    if (!isPlainRecord(statement) || !hasOnlyKeys(statement, ["sql", "params"])) {
      throw new TypeError("transaction statement has an invalid shape");
    }
    const sql = readOwnDataProperty(statement, "sql");
    const params = Object.hasOwn(statement, "params")
      ? readOwnDataProperty(statement, "params")
      : [];
    return snapshotStatement({ sql, params });
  });
}

function snapshotStatement(value: unknown): BoundStatement {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["sql", "params"])) {
    throw new TypeError("SQL statement has an invalid shape");
  }
  const sql = readOwnDataProperty(value, "sql");
  if (typeof sql !== "string") throw new TypeError("SQL must be a string");
  if (
    sql.length === 0 ||
    sql.length > MAX_SQL_BYTES ||
    utf8Bytes(sql) > MAX_SQL_BYTES ||
    sql.includes("\u0000")
  ) {
    throw new SelfhostV2SqliteError("sql_error");
  }
  const rawParams = Object.hasOwn(value, "params") ? readOwnDataProperty(value, "params") : [];
  const rawParamValues = arrayValues(rawParams, MAX_PARAMETERS);
  if (rawParamValues.length > MAX_PARAMETERS) {
    throw new TypeError("SQL params must be an array of at most 100 values");
  }
  const params = rawParamValues.map(bindableInput);
  return Object.freeze({ sql, params: Object.freeze(params) });
}

function bindableInput(value: unknown): SQLInputValue {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_SAFE_INTEGER) {
      throw new TypeError("SQL number must be finite and within the safe integer range");
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_SQL_VALUE_BYTES) {
      throw new TypeError("SQL string must be valid bounded UTF-8");
    }
    const bytes = UTF8.encode(value);
    if (
      bytes.byteLength > MAX_SQL_VALUE_BYTES ||
      new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value
    ) {
      throw new TypeError("SQL string must be valid bounded UTF-8");
    }
    return value;
  }
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["encoding", "data"])) {
    throw new TypeError("SQL value must be null, a safe number, string, or base64 blob");
  }
  const encoding = readOwnDataProperty(value, "encoding");
  const data = readOwnDataProperty(value, "data");
  if (encoding !== "base64" || typeof data !== "string") {
    throw new TypeError("SQL blob must use the base64 encoding shape");
  }
  if (data.length > Math.ceil(MAX_SQL_VALUE_BYTES / 3) * 4) {
    throw new TypeError("SQL blob must use bounded padded base64");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength > MAX_SQL_VALUE_BYTES || bytes.toString("base64") !== data) {
    throw new TypeError("SQL blob must use bounded padded base64");
  }
  return new Uint8Array(bytes);
}

function encodeOutput(value: unknown): EdgeSqlValue {
  if (value === null) return null;
  if (typeof value === "bigint") {
    if (value > BigInt(MAX_SAFE_INTEGER) || value < BigInt(-MAX_SAFE_INTEGER)) {
      throw new SelfhostV2SqliteError("numeric_out_of_range");
    }
    return Number(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_SAFE_INTEGER) {
      throw new SelfhostV2SqliteError("numeric_out_of_range");
    }
    return value;
  }
  if (typeof value === "string") {
    if (utf8Bytes(value) > MAX_SQL_VALUE_BYTES) {
      throw new SelfhostV2SqliteError("sql_error");
    }
    return value;
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_SQL_VALUE_BYTES) {
      throw new SelfhostV2SqliteError("sql_error");
    }
    return Object.freeze({ encoding: "base64", data: Buffer.from(value).toString("base64") });
  }
  throw new SelfhostV2SqliteError("sql_error");
}

function changesWritten(database: DatabaseSync): number {
  const statement = database.prepare("SELECT changes() AS changes");
  statement.setReadBigInts(true);
  const result = statement.get() as Record<string, unknown> | undefined;
  const changes = result?.changes;
  if (typeof changes === "bigint") {
    if (changes < 0n || changes > BigInt(MAX_SAFE_INTEGER)) {
      throw new SelfhostV2SqliteError("numeric_out_of_range");
    }
    return Number(changes);
  }
  if (typeof changes === "number" && Number.isSafeInteger(changes) && changes >= 0) {
    return changes;
  }
  throw new SelfhostV2SqliteError("numeric_out_of_range");
}

/** Frame exactly one parser input; SQLite itself decides whether that input is SQL. */
function assertSingleStatement(sql: string): void {
  let index = 0;
  let ended = false;
  let hasContent = false;
  while (index < sql.length) {
    const character = sql[index] as string;
    if (character === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      if (close < 0) throw new SelfhostV2SqliteError("sql_error");
      index = close + 2;
      continue;
    }
    if (isSqlWhitespace(character)) {
      index += 1;
      continue;
    }
    if (ended) throw new SelfhostV2SqliteError("sql_error");
    if (character === ";") {
      if (!hasContent) throw new SelfhostV2SqliteError("sql_error");
      ended = true;
      index += 1;
      continue;
    }
    hasContent = true;
    if (character === "'" || character === '"' || character === "`") {
      index = skipQuoted(sql, index, character);
      continue;
    }
    if (character === "[") {
      const close = sql.indexOf("]", index + 1);
      if (close < 0) throw new SelfhostV2SqliteError("sql_error");
      index = close + 1;
      continue;
    }
    index += 1;
  }
  if (!hasContent) throw new SelfhostV2SqliteError("sql_error");
}

function skipQuoted(sql: string, start: number, delimiter: string): number {
  let cursor = start + 1;
  while (cursor < sql.length) {
    const close = sql.indexOf(delimiter, cursor);
    if (close < 0) throw new SelfhostV2SqliteError("sql_error");
    if (sql[close + 1] === delimiter) {
      cursor = close + 2;
      continue;
    }
    return close + 1;
  }
  throw new SelfhostV2SqliteError("sql_error");
}

function normalizeSqliteError(error: unknown, isOpen: boolean): SelfhostV2SqliteError {
  if (error instanceof SelfhostV2SqliteError) return error;
  if (!isOpen || errorCode(error) === "ERR_INVALID_STATE") {
    return new SelfhostV2SqliteError("backend_unavailable");
  }
  const code = errorNumber(error, "errcode");
  if (code !== undefined && (code & 0xff) === 5) return new SelfhostV2SqliteError("busy");
  if (code !== undefined && (code & 0xff) === 6) return new SelfhostV2SqliteError("busy");
  return new SelfhostV2SqliteError("sql_error");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorNumber(error: unknown, key: "errcode"): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function arrayValues(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("SQL statement lists and params must be arrays");
  if (value.length > maximum) throw new TypeError("SQL array exceeds its item limit");
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("SQL arrays must contain own data values without holes");
    }
    result.push(descriptor.value);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= value.length),
    )
  ) {
    throw new TypeError("SQL arrays cannot have extra properties");
  }
  return result;
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string" && allowed.includes(key));
}

function readOwnDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError("SQL arguments must use own data properties");
  }
  return descriptor.value;
}

function utf8Bytes(value: string): number {
  return UTF8.encode(value).byteLength;
}

function isSqlWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r" || value === "\f";
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}
