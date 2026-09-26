/**
 * CHILD-ONLY, unadmitted Takoserver Actor execution slice.
 *
 * The native Host supplies an already loaded class and an actor-private SQLite
 * store. Neither native state nor the SQL cursor crosses into application code.
 * This adapter does not load code, schedule IDs, retire children, or reserve a
 * streaming invocation. Its owner must admit one invocation at a time and own
 * the returned response lifetime. It is not wired into production admission.
 */
import {
  ActorRuntimeError,
  createActorClassExecution,
  createActorContext,
  createActorTurn,
} from "./actor-class-execution.ts";

export type ActorSqlValue =
  | null
  | string
  | number
  | { readonly encoding: "base64"; readonly data: string };
export interface ActorSqlResult {
  readonly rows: readonly Readonly<Record<string, ActorSqlValue>>[];
  readonly rowsWritten: number;
}
export interface ActorSqlStatement {
  readonly sql: string;
  readonly params?: readonly ActorSqlValue[];
}
export interface NativeActorStorage {
  readonly sql: {
    exec(
      sql: string,
      ...params: (null | string | number | Uint8Array)[]
    ): Iterable<Record<string, unknown>> & {
      readonly rowsWritten: number;
    };
  };
  transactionSync<T>(callback: () => T): T;
}

export interface NativeActorSqlFacade {
  execute(sql: string, params?: readonly ActorSqlValue[]): Promise<ActorSqlResult>;
  query(sql: string, params?: readonly ActorSqlValue[]): Promise<ActorSqlResult>;
  transaction(
    statements: readonly ActorSqlStatement[],
  ): Promise<{ readonly results: readonly ActorSqlResult[] }>;
}

type SqlCode =
  | "invalid_sql"
  | "constraint_violation"
  | "numeric_out_of_range"
  | "result_too_large"
  | "storage_full"
  | "busy"
  | "backend_unavailable";
const sqlErrors = new WeakSet<Error>();
function sqlError(code: SqlCode = "invalid_sql"): Error & { readonly code: SqlCode } {
  const error = new Error("Actor SQL operation failed") as Error & { readonly code: SqlCode };
  Object.defineProperties(error, { name: { value: code }, code: { value: code } });
  sqlErrors.add(error);
  return error;
}
function sqlFailure(error: unknown, query = false): Error {
  let code: SqlCode = "backend_unavailable";
  if (error instanceof Error && sqlErrors.has(error)) code = error.name as SqlCode;
  else if (error instanceof Error) {
    const message = error.message;
    if (/constraint failed|SQLITE_CONSTRAINT/i.test(message)) code = "constraint_violation";
    else if (/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)) code = "busy";
    else if (/database or disk is full|SQLITE_FULL/i.test(message)) code = "storage_full";
    else if (
      /syntax error|no such (?:table|column)|incomplete input|not authorized|SQLITE_ERROR|SQLITE_AUTH/i.test(
        message,
      )
    )
      code = "invalid_sql";
  }
  // storageQuery has a narrower closed error set than execute/transaction.
  if (query && (code === "constraint_violation" || code === "storage_full"))
    code = "backend_unavailable";
  return sqlError(code);
}
const encoder = new TextEncoder();
const utf8Length = (value: string): number => encoder.encode(value).byteLength;
function numberValue(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
    throw sqlError("numeric_out_of_range");
  return value;
}

function decode(value: ActorSqlValue): null | string | number | Uint8Array {
  if (value === null) return value;
  if (typeof value === "string") {
    if (utf8Length(value) > 1_000_000) throw sqlError();
    return value;
  }
  if (typeof value === "number") return numberValue(value);
  if (
    typeof value === "object" &&
    value !== null &&
    value.encoding === "base64" &&
    typeof value.data === "string" &&
    Object.hasOwn(value, "encoding") &&
    Object.hasOwn(value, "data") &&
    Object.keys(value).length === 2 &&
    value.data.length <= 1_333_336
  ) {
    let bytes: string;
    try {
      bytes = atob(value.data);
    } catch {
      throw sqlError();
    }
    if (btoa(bytes) !== value.data || bytes.length > 1_000_000) throw sqlError();
    return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
  }
  throw sqlError();
}

function encode(value: unknown): ActorSqlValue {
  if (value === null) return value;
  if (typeof value === "string") {
    if (utf8Length(value) > 1_000_000) throw sqlError("result_too_large");
    return value;
  }
  if (typeof value === "number") return numberValue(value);
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (bytes instanceof Uint8Array) {
    if (bytes.byteLength > 1_000_000) throw sqlError("result_too_large");
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { encoding: "base64", data: btoa(binary) };
  }
  throw sqlError("backend_unavailable");
}

/** Lexical statement boundary, not a SQL parser; native SQLite validates syntax.
 * Trigger bodies are one schema statement even though their BEGIN/END block
 * contains semicolons. Quoted strings/identifiers and comments are inert here.
 */
function admitStatement(sql: string): string {
  let index = 0;
  let terminated = false;
  let content = false;
  let trigger = false;
  let triggerSemicolon = false;
  let triggerEnd = false;
  let terminalIndex: number | undefined;
  const words: string[] = [];
  while (index < sql.length) {
    const char = sql[index] as string;
    if (/\s/u.test(char)) {
      index++;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index + 2);
      index = end < 0 ? sql.length : end;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw sqlError();
      index = end + 2;
      continue;
    }
    if (terminated) throw sqlError();
    if (char === ";") {
      if (!content) throw sqlError();
      if (!trigger || triggerEnd) {
        terminated = true;
        terminalIndex = index;
      }
      triggerSemicolon = true;
      triggerEnd = false;
      index++;
      continue;
    }
    content = true;
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      triggerSemicolon = false;
      triggerEnd = false;
      const close = char === "[" ? "]" : char;
      index++;
      let closed = false;
      while (index < sql.length) {
        if (sql[index++] !== close) continue;
        if (char !== "[" && sql[index] === close) {
          index++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw sqlError();
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      const start = index++;
      while (index < sql.length && /[A-Za-z0-9_$]/u.test(sql[index] as string)) index++;
      const word = sql.slice(start, index).toLowerCase();
      words.push(word);
      let first =
        words[0] === "explain" ? (words[1] === "query" && words[2] === "plan" ? 3 : 1) : 0;
      if (words[first] === "create") {
        first++;
        if (words[first] === "temp" || words[first] === "temporary") first++;
        trigger = words[first] === "trigger";
      }
      // A trigger completes at '; END ;', not at an arbitrary END token in
      // an expression. BEGIN/END can also be unquoted column identifiers.
      triggerEnd = trigger && triggerSemicolon && word === "end";
      triggerSemicolon = false;
      continue;
    }
    triggerSemicolon = false;
    triggerEnd = false;
    index++;
  }
  const first =
    words[0] === "explain"
      ? words[1] === "query" && words[2] === "plan"
        ? words[3]
        : words[1]
      : words[0];
  if (
    !content ||
    first === undefined ||
    /^(?:begin|commit|end|rollback|savepoint|release|attach|detach|pragma|vacuum)$/u.test(first)
  )
    throw sqlError();
  // Native exec treats a trailing comment after ';' as an empty second
  // statement. Remove only the delimiter/tail already validated above.
  return terminalIndex === undefined ? sql : sql.slice(0, terminalIndex);
}

function createSqlFacade(storage: NativeActorStorage): NativeActorSqlFacade {
  function run(sql: string, params: readonly ActorSqlValue[] = []): ActorSqlResult {
    if (
      typeof sql !== "string" ||
      utf8Length(sql) > 100_000 ||
      !Array.isArray(params) ||
      params.length > 100
    )
      throw sqlError();
    const statement = admitStatement(sql);
    const cursor = storage.sql.exec(statement, ...params.map(decode));
    const rows: Record<string, ActorSqlValue>[] = [];
    let materializedBytes = 0;
    for (const row of cursor) {
      if (rows.length >= 10_000 || Object.keys(row).length > 100)
        throw sqlError("result_too_large");
      const result = Object.create(null) as Record<string, ActorSqlValue>;
      for (const [key, value] of Object.entries(row)) {
        if (utf8Length(key) > 128) throw sqlError("result_too_large");
        result[key] = encode(value);
      }
      const rowBytes = utf8Length(JSON.stringify(result));
      materializedBytes += rowBytes + 1;
      if (rowBytes > 2_000_000 || materializedBytes > 8_388_608) throw sqlError("result_too_large");
      rows.push(result);
    }
    if (!Number.isSafeInteger(cursor.rowsWritten) || cursor.rowsWritten < 0)
      throw sqlError("backend_unavailable");
    return boundedResult({ rows, rowsWritten: cursor.rowsWritten });
  }
  function boundedResult<T>(result: T): T {
    if (utf8Length(JSON.stringify(result)) > 8_388_608) throw sqlError("result_too_large");
    return result;
  }
  return Object.freeze({
    async execute(sql: string, params?: readonly ActorSqlValue[]): Promise<ActorSqlResult> {
      try {
        // Also rolls back if result projection fails, instead of committing
        // an operation whose result the application cannot observe.
        return storage.transactionSync(() => run(sql, params));
      } catch (error) {
        throw sqlFailure(error);
      }
    },
    async query(sql: string, params?: readonly ActorSqlValue[]): Promise<ActorSqlResult> {
      const rollback = Object.freeze({});
      let result: ActorSqlResult | undefined;
      try {
        storage.transactionSync(() => {
          result = run(sql, params);
          // Every query rolls back, including DDL and writes with RETURNING.
          // A rowsWritten check alone does not detect all SQL mutations.
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback || result === undefined) throw sqlFailure(error, true);
        return { rows: result.rows, rowsWritten: 0 };
      }
      throw sqlError();
    },
    async transaction(
      statements: readonly ActorSqlStatement[],
    ): Promise<{ results: readonly ActorSqlResult[] }> {
      try {
        if (!Array.isArray(statements) || statements.length === 0 || statements.length > 100)
          throw sqlError();
        return storage.transactionSync(() => {
          const results: ActorSqlResult[] = [];
          let materializedBytes = 0;
          for (const statement of statements) {
            if (
              typeof statement !== "object" ||
              statement === null ||
              Array.isArray(statement) ||
              !Object.hasOwn(statement, "sql") ||
              Object.keys(statement).some((key) => key !== "sql" && key !== "params")
            )
              throw sqlError();
            const result = run(statement.sql, statement.params);
            materializedBytes += utf8Length(JSON.stringify(result)) + 1;
            if (materializedBytes > 8_388_608) throw sqlError("result_too_large");
            results.push(result);
          }
          return boundedResult({ results });
        });
      } catch (error) {
        throw sqlFailure(error);
      }
    },
  });
}

export function createNativeActorExecution(options: {
  readonly namespace: Readonly<Record<string, unknown>>;
  readonly exportName: string;
  readonly id: string;
  readonly env: Readonly<Record<string, unknown>>;
  readonly storage: NativeActorStorage;
}): { fetch(request: Request): Promise<Response> } {
  const unavailable = async (): Promise<never> => {
    throw new ActorRuntimeError("backend_unavailable");
  };
  const execution = createActorClassExecution({
    namespace: options.namespace,
    exportName: options.exportName,
    env: options.env,
    context: createActorContext({
      id: options.id,
      storage: createSqlFacade(options.storage) as unknown as Readonly<Record<string, unknown>>,
      alarm: Object.freeze({ set: unavailable, get: unavailable, clear: unavailable }),
      sockets: Object.freeze({ accept: unavailable, get: unavailable, list: unavailable }),
    }),
  });
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const response = await execution.dispatch(
        { kind: "fetch", request },
        createActorTurn(request.signal),
      );
      if (response === undefined) throw new ActorRuntimeError("backend_unavailable");
      // Preserve the real Response and its streaming body. The owner, not this
      // adapter, retains the admission reservation through the chosen lifetime.
      return response;
    },
  });
}
