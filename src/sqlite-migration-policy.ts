/**
 * Migration scripts may change the declared database, not the Host's files,
 * ledger, or transaction boundary. The same lexical pass applies that policy
 * and frames complete statements, so execution never depends on a second SQL
 * splitter with different quote, comment, or trigger rules.
 */
const TRANSACTION_OR_EXTERNAL_COMMANDS = new Set([
  "begin",
  "commit",
  "end",
  "rollback",
  "savepoint",
  "release",
  "attach",
  "detach",
  "vacuum",
]);

// The provider policy only assigns this transaction-scoped setting. Native
// callers select the exact accepted Form's additional read permission below.
// Existing durable receipts are never rewritten.
const DEFER_FOREIGN_KEYS_VALUES = new Set(["on", "off", "true", "false", "1", "0"]);
const READ_ONLY_MIGRATION_PRAGMAS = new Set([
  "table_info",
  "foreign_key_list",
  "index_list",
  "index_info",
]);

export function isMigrationIntrospectionPragma(value: string | null): boolean {
  return (
    value !== null &&
    /^[A-Za-z_]+$/u.test(value) &&
    READ_ONLY_MIGRATION_PRAGMAS.has(value.toLowerCase())
  );
}

export interface MigrationSqlStatement {
  readonly sql: string;
  /** Actual outer command; trigger-body commands do not replace it. */
  readonly command: string | null;
  readonly pragma: "defer" | "introspection" | null;
}

/** Chosen by the trusted native adapter from the exact accepted Form identity. */
export function prepareNativeMigrationSql(
  sql: string,
  pragmas: "deny" | "defer" | "introspection",
): readonly MigrationSqlStatement[] {
  return scanMigrationSql(sql, undefined, undefined, pragmas);
}

/** SQLite keyword/name case folding is ASCII; Unicode aliases are not names. */
export function isMigrationDeferForeignKeysName(value: string | null): boolean {
  return (
    value !== null && /^[A-Za-z_]+$/u.test(value) && value.toLowerCase() === "defer_foreign_keys"
  );
}

/** Only parsed, bare values; this does not authorize a SQL statement by itself. */
export function isMigrationDeferForeignKeysValue(value: string | null): boolean {
  return (
    value !== null &&
    /^[A-Za-z0-9]+$/u.test(value) &&
    DEFER_FOREIGN_KEYS_VALUES.has(value.toLowerCase())
  );
}

const COMPLETE_SEMI = 0;
const COMPLETE_WS = 1;
const COMPLETE_OTHER = 2;
const COMPLETE_EXPLAIN = 3;
const COMPLETE_CREATE = 4;
const COMPLETE_TEMP = 5;
const COMPLETE_TRIGGER = 6;
const COMPLETE_END = 7;

type CompleteToken =
  | typeof COMPLETE_SEMI
  | typeof COMPLETE_WS
  | typeof COMPLETE_OTHER
  | typeof COMPLETE_EXPLAIN
  | typeof COMPLETE_CREATE
  | typeof COMPLETE_TEMP
  | typeof COMPLETE_TRIGGER
  | typeof COMPLETE_END;

type CompleteState = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * This is the transition table from SQLite 3.47.0 `src/complete.c`, with
 * statement boundaries exposed in the same place as Cloudflare workerd's
 * `sqlite3_complete_length(..., firstOnly=1)` patch.
 *
 * Provenance for the exact runtime exercised by the managed-object tests:
 * - workerd `v1.20260811.1` pins `sqlite-src-3470000.zip` (SQLite 3.47.0),
 *   SHA-256 f59c349bedb470203586a6b6d10adb35f2afefa49f91e55a672a36a09a8fedf7
 *   https://sqlite.org/2024/sqlite-src-3470000.zip
 * - workerd patch `0003-sqlite-complete-early-exit.patch`, unchanged since
 *   commit d82473051a2611a822aff888e428755a89ac406f, SHA-256
 *   a888b933c4c6464d1c9b954421a683b21bb138c146bd3273292ec2c2e1790eed
 *   https://github.com/cloudflare/workerd/blob/v1.20260811.1/patches/sqlite/0003-sqlite-complete-early-exit.patch
 *
 * SQLite's core source is public domain. This TypeScript port deliberately
 * keeps the upstream state numbers, token classes, and transitions visible so
 * a runtime SQLite upgrade can be compared table-for-table.
 */
const COMPLETE_TRANSITIONS = [
  // Token:       ;  WS  OTHER  EXPLAIN  CREATE  TEMP  TRIGGER  END
  /* INVALID */ [1, 0, 2, 3, 4, 2, 2, 2],
  /* START   */ [1, 1, 2, 3, 4, 2, 2, 2],
  /* NORMAL  */ [1, 2, 2, 2, 2, 2, 2, 2],
  /* EXPLAIN */ [1, 3, 3, 2, 4, 2, 2, 2],
  /* CREATE  */ [1, 4, 2, 2, 2, 4, 5, 2],
  /* TRIGGER */ [6, 5, 5, 5, 5, 5, 5, 5],
  /* SEMI    */ [6, 6, 5, 5, 5, 5, 5, 7],
  /* END     */ [1, 7, 5, 5, 5, 5, 5, 5],
] as const;

/** A valid migration statement exceeds a backend's native SQL capacity. */
export class MigrationSqlCapacityError extends Error {
  constructor(
    readonly maximumStatementBytes: number,
    readonly actualStatementBytes: number,
  ) {
    super("migration statement exceeds the backend SQL capacity");
    this.name = "MigrationSqlCapacityError";
  }
}

/**
 * Applies migration authority policy and returns the exact executable source
 * slices accepted by SQLite's statement-completeness state machine.
 *
 * Slices are never trimmed, normalized, re-encoded, or reordered. Empty
 * statements and a trailing comment/separator-only suffix are not executable
 * and therefore are not returned; their bytes remain part of the original
 * migration identity. A final executable statement may omit its semicolon,
 * because the published SQLiteMigrationSet contract does not require one.
 */
export function prepareMigrationSql(
  sql: string,
  maximumStatementBytes?: number,
): readonly string[] {
  return scanMigrationSql(sql, maximumStatementBytes, {
    identifier(value) {
      const lower = value.toLowerCase();
      // Preserve the provider adapters' existing conservative identifier fence.
      if (
        lower.startsWith("_takoform_") ||
        lower.startsWith("_cf_") ||
        lower === "__cf_kv" ||
        lower === "load_extension" ||
        lower.startsWith("pragma_")
      ) {
        refuseMigrationSql();
      }
    },
    command(value) {
      if (TRANSACTION_OR_EXTERNAL_COMMANDS.has(value)) refuseMigrationSql();
    },
  }).map((statement) => statement.sql);
}

/**
 * The same PRAGMA grammar/completeness pass for a native SQLite authorizer.
 * Other SQL effects remain that authorizer's responsibility: a harmless string
 * literal must not acquire the providers' context-free identifier restrictions.
 */
export function assertMigrationPragmaAssignments(sql: string): void {
  scanMigrationSql(sql);
}

/** Retained Application 0.2.0 never admitted PRAGMA effects. */
export function assertMigrationPragmasDenied(sql: string): void {
  scanMigrationSql(sql, undefined, undefined, "deny");
}

/** One parser-extracted PRAGMA statement, using the same token/grammar pass. */
export function isMigrationPragmaAssignment(statement: string): boolean {
  try {
    scanMigrationSql(statement, undefined, undefined, "defer", true);
    return true;
  } catch {
    return false;
  }
}

function refuseMigrationSql(): never {
  throw new Error("migration SQL is unsafe or incomplete");
}

function scanMigrationSql(
  sql: string,
  maximumStatementBytes?: number,
  authority?: {
    readonly identifier: (value: string) => void;
    readonly command: (value: string) => void;
  },
  pragmaPolicy: "deny" | "defer" | "introspection" = "defer",
  singlePragmaStatement = false,
): readonly MigrationSqlStatement[] {
  const refuse = (): never => {
    return refuseMigrationSql();
  };
  if (typeof sql !== "string" || sql.includes("\u0000")) refuse();
  if (
    maximumStatementBytes !== undefined &&
    (!Number.isSafeInteger(maximumStatementBytes) || maximumStatementBytes < 1)
  ) {
    throw new TypeError("maximumStatementBytes must be a positive safe integer");
  }

  let state: CompleteState = 0;
  let index = 0;
  let sliceStart = 0;
  let hasExecutableToken = false;
  const statements: MigrationSqlStatement[] = [];
  let outerCommand: string | null = null;
  let statementPragma: MigrationSqlStatement["pragma"] = null;
  let capacityError: MigrationSqlCapacityError | undefined;

  // Policy state is advanced by the same tokens used for completeness.
  let commandPending = true;
  let explainPrefix: 0 | 1 | 2 | 3 = 0;
  let command: string | null = null;
  let head: string[] = [];
  let triggerHeader = false;
  let triggerBody = false;
  // 0: none; 1: name; 2: '='; 3: value; 4: defer end;
  // 5: read arguments (SQLite parses them); 6: schema '.'; 7: read name.
  const pragma: { state: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 } = { state: 0 };
  let pragmaKeywordEnd = 0;
  let pragmaCount = 0;
  let pragmaStart = 0;
  let pragmaEnd = 0;

  const resetCommand = (): void => {
    commandPending = true;
    explainPrefix = 0;
    command = null;
  };

  const identifier = (value: string): void => {
    // SQLite accepts quoted strings in some identifier positions. Reserve
    // provider-owned names there as well as in ordinary identifier tokens.
    authority?.identifier(value);
  };

  const pragmaName = (value: string, quoted = false): void => {
    if (pragmaPolicy === "introspection") {
      if (pragma.state === 1 && /^[Mm][Aa][Ii][Nn]$/u.test(value)) {
        pragma.state = 6;
        return;
      }
      if (isMigrationIntrospectionPragma(value)) {
        pragma.state = 5;
        statementPragma = "introspection";
        return;
      }
    }
    if (pragma.state === 1 && !quoted && isMigrationDeferForeignKeysName(value)) {
      const gap = sql.slice(pragmaKeywordEnd, index);
      if (!gap || !onlyPragmaWhitespace(gap)) refuse();
      pragma.state = 2;
      statementPragma = "defer";
      return;
    }
    refuse();
  };

  const word = (value: string): void => {
    const lower = value.toLowerCase();
    identifier(lower);

    if (pragma.state !== 0 && pragma.state !== 5) {
      if (pragma.state === 1 || pragma.state === 7) {
        pragmaName(value);
        return;
      }
      if (pragma.state === 3 && isMigrationDeferForeignKeysValue(value)) {
        pragma.state = 4;
        pragmaEnd = index + value.length;
        return;
      }
      refuse();
    }

    if (commandPending) {
      // A BOM inside a word remains an SQLite identifier character. Refuse
      // this invalid PRAGMA-looking command without splitting valid Unicode
      // identifiers elsewhere or claiming it could execute a PRAGMA effect.
      if (lower.startsWith("pragma\ufeff")) refuse();
      if (explainPrefix === 0 && lower === "explain") {
        explainPrefix = 1;
      } else if (explainPrefix === 1 && lower === "query") {
        explainPrefix = 2;
      } else if (explainPrefix === 2 && lower === "plan") {
        explainPrefix = 3;
      } else {
        commandPending = false;
        command = lower;
        outerCommand ??= lower;
        if (triggerBody && lower === "end") {
          triggerBody = false;
          triggerHeader = false;
        } else {
          authority?.command(lower);
        }
      }
    }

    if (!triggerBody) {
      if (head.length < 4) head.push(lower);
      const create = head[0] === "explain" ? 1 : 0;
      triggerHeader =
        triggerHeader ||
        (head[create] === "create" &&
          (head[create + 1] === "trigger" ||
            ((head[create + 1] === "temp" || head[create + 1] === "temporary") &&
              head[create + 2] === "trigger")));
      if (triggerHeader && lower === "begin") {
        triggerBody = true;
        resetCommand();
        head = [];
      }
    }

    if (lower === "pragma" && command === "pragma" && pragma.state === 0) {
      if (explainPrefix !== 0 || pragmaPolicy === "deny") refuse();
      pragmaCount += 1;
      pragmaStart = index;
      pragmaKeywordEnd = index + value.length;
      pragma.state = 1;
    }
  };

  const semicolon = (): void => {
    if (pragma.state !== 0 && pragma.state !== 4 && pragma.state !== 5) refuse();
    if (pragma.state === 4) pragmaEnd = index + 1;
    pragma.state = 0;
    resetCommand();
    head = [];
    if (!triggerBody) triggerHeader = false;
  };

  const emit = (end: number): void => {
    const statement = sql.slice(sliceStart, end);
    if (maximumStatementBytes !== undefined) {
      const actualStatementBytes = new TextEncoder().encode(statement).byteLength;
      if (actualStatementBytes > maximumStatementBytes && capacityError === undefined) {
        capacityError = new MigrationSqlCapacityError(maximumStatementBytes, actualStatementBytes);
      }
    }
    statements.push({ sql: statement, command: outerCommand, pragma: statementPragma });
    sliceStart = end;
    hasExecutableToken = false;
    outerCommand = null;
    statementPragma = null;
  };

  while (index < sql.length) {
    const character = sql[index] as string;
    let token: CompleteToken = COMPLETE_OTHER;
    let end = index + 1;

    if (character === ";") {
      token = COMPLETE_SEMI;
      semicolon();
    } else if (pragma.state !== 0 && isPragmaWhitespace(character)) {
      token = COMPLETE_WS;
    } else if (isCompleteWhitespace(character)) {
      // Non-ASCII whitespace is never part of the permitted assignment.
      if (
        pragma.state !== 0 &&
        pragma.state !== 5 &&
        !(pragmaPolicy === "introspection" && [1, 6, 7].includes(pragma.state))
      )
        refuse();
      token = COMPLETE_WS;
    } else if (character === "/" && sql[index + 1] === "*") {
      if (
        pragma.state !== 0 &&
        pragma.state !== 5 &&
        !(pragmaPolicy === "introspection" && [1, 6, 7].includes(pragma.state))
      )
        refuse();
      const commentEnd = sql.indexOf("*/", index + 2);
      if (commentEnd < 0) refuse();
      end = commentEnd + 2;
      token = COMPLETE_WS;
    } else if (character === "-" && sql[index + 1] === "-") {
      if (
        pragma.state !== 0 &&
        pragma.state !== 5 &&
        !(pragmaPolicy === "introspection" && [1, 6, 7].includes(pragma.state))
      )
        refuse();
      const newline = sql.indexOf("\n", index + 2);
      end = newline < 0 ? sql.length : newline + 1;
      token = COMPLETE_WS;
    } else if (character === "[") {
      if (
        pragma.state !== 0 &&
        pragma.state !== 5 &&
        !(pragmaPolicy === "introspection" && [1, 7].includes(pragma.state))
      )
        refuse();
      const close = sql.indexOf("]", index + 1);
      if (close < 0) refuse();
      const value = sql.slice(index + 1, close);
      if (pragma.state === 1 || pragma.state === 7) pragmaName(value, true);
      else identifier(value);
      end = close + 1;
    } else if (character === "'" || character === '"' || character === "`") {
      if (
        pragma.state !== 0 &&
        pragma.state !== 5 &&
        !(pragmaPolicy === "introspection" && [1, 7].includes(pragma.state))
      )
        refuse();
      let cursor = index + 1;
      let value = "";
      for (;;) {
        const close = sql.indexOf(character, cursor);
        if (close < 0) refuse();
        value += sql.slice(cursor, close);
        if (sql[close + 1] === character) {
          value += character;
          cursor = close + 2;
          continue;
        }
        end = close + 1;
        break;
      }
      if (pragma.state === 1 || pragma.state === 7) pragmaName(value, true);
      else identifier(value);
    } else {
      const codePoint = sql.codePointAt(index);
      if (codePoint !== undefined && isSqliteIdentifierCodePoint(codePoint)) {
        let cursor = index + codePointWidth(codePoint);
        while (cursor < sql.length) {
          const next = sql.codePointAt(cursor);
          if (next === undefined || !isSqliteIdentifierCodePoint(next)) break;
          cursor += codePointWidth(next);
        }
        const value = sql.slice(index, cursor);
        word(value);
        token = completeKeyword(value);
        end = cursor;
      } else if (pragma.state === 2 && character === "=") {
        pragma.state = 3;
      } else if (pragma.state === 6 && character === ".") {
        pragma.state = 7;
      } else if (pragma.state !== 0 && pragma.state !== 5) {
        refuse();
      }
    }

    state = completeTransition(state, token);
    index = end;
    if (token !== COMPLETE_WS && token !== COMPLETE_SEMI) hasExecutableToken = true;

    // The workerd patch returns here for the first complete semicolon span.
    // Keep leading empty semicolons/comments pending so `sql.exec()` is never
    // called with a separator-only string; they remain an exact prefix of the
    // next executable slice.
    if (token === COMPLETE_SEMI && state === 1 && hasExecutableToken) emit(index);
  }

  if ((pragma.state !== 0 && pragma.state !== 4 && pragma.state !== 5) || triggerBody) refuse();

  if (hasExecutableToken) {
    // sqlite3_complete() requires the terminator. The Form does not, so prove
    // that only a final semicolon is missing, then execute the original slice
    // without appending, trimming, or otherwise changing it.
    if (completeTransition(state, COMPLETE_SEMI) !== 1) refuse();
    emit(sql.length);
  }

  // Finish the authority and completeness pass before reporting capacity, so
  // an oversized early statement can never hide a forbidden or incomplete
  // construct later in the same file.
  if (capacityError !== undefined) throw capacityError;
  if (
    singlePragmaStatement &&
    (pragmaCount !== 1 ||
      statements.length !== 1 ||
      !onlyPragmaWhitespace(sql.slice(0, pragmaStart)) ||
      !onlyPragmaWhitespace(sql.slice(pragmaEnd)))
  ) {
    refuse();
  }
  return statements;
}

function isPragmaWhitespace(value: string): boolean {
  return value === " " || (value >= "\t" && value <= "\r");
}

function onlyPragmaWhitespace(value: string): boolean {
  for (const character of value) if (!isPragmaWhitespace(character)) return false;
  return true;
}

/** Applies the shared authority/completeness policy without an execution cap. */
export function assertSafeMigrationSql(sql: string): void {
  prepareMigrationSql(sql);
}

function completeTransition(state: CompleteState, token: CompleteToken): CompleteState {
  return COMPLETE_TRANSITIONS[state][token] as CompleteState;
}

function completeKeyword(value: string): CompleteToken {
  switch (value.toLowerCase()) {
    case "explain":
      return COMPLETE_EXPLAIN;
    case "create":
      return COMPLETE_CREATE;
    case "temp":
    case "temporary":
      return COMPLETE_TEMP;
    case "trigger":
      return COMPLETE_TRIGGER;
    case "end":
      return COMPLETE_END;
    default:
      return COMPLETE_OTHER;
  }
}

function isCompleteWhitespace(value: string): boolean {
  return (
    value === " " ||
    value === "\r" ||
    value === "\t" ||
    value === "\n" ||
    value === "\f" ||
    // SQLite's execution tokenizer treats the UTF-8 BOM as whitespace at the
    // beginning and between tokens. Preserve it in the exact slice, but do not
    // let it merge with BEGIN/ATTACH or break CREATE TRIGGER recognition.
    value === "\ufeff"
  );
}

function isSqliteIdentifierCodePoint(value: number): boolean {
  return (
    value >= 0x80 ||
    value === 0x24 ||
    value === 0x5f ||
    (value >= 0x30 && value <= 0x39) ||
    (value >= 0x41 && value <= 0x5a) ||
    (value >= 0x61 && value <= 0x7a)
  );
}

function codePointWidth(value: number): 1 | 2 {
  return value > 0xffff ? 2 : 1;
}
