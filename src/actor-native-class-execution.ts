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
import {
  actorUpgradeResponseSource,
  createActorUpgradeResponse,
  validActorUpgradeHeaders,
} from "./actor-upgrade-handoff.ts";

const SafeObjectFreeze = Object.freeze;
const SafeObjectKeys = Object.keys;
const SafeArrayMap = Array.prototype.map;
const SafeArraySome = Array.prototype.some;
const SafeWeakMap = WeakMap;
const SafeWeakMapGet = WeakMap.prototype.get;
const SafeWeakMapSet = WeakMap.prototype.set;
const SafeWeakMapDelete = WeakMap.prototype.delete;
const SafeHeaders = Headers;
const SafeResponseHeaders = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get;
const SafeHeadersForEach = Headers.prototype.forEach;
const SafeReflectApply = Reflect.apply;
const SafeRequestMethod = Object.getOwnPropertyDescriptor(Request.prototype, "method")?.get;
const SafeRequestHeaders = Object.getOwnPropertyDescriptor(Request.prototype, "headers")?.get;
const SafeHeadersGet = Headers.prototype.get;
const SafeStringLower = String.prototype.toLowerCase;
const SafeUint8ArraySlice = Uint8Array.prototype.slice;
const SafeNumberIsSafeInteger = Number.isSafeInteger;
const SafeTextEncoder = TextEncoder;
const SafeTextEncode = TextEncoder.prototype.encode;
const SafeRegExpTest = RegExp.prototype.test;
const SOCKET_PROTOCOL = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;
const MAX_SOCKET_MESSAGE_BYTES = 8_388_608;
const MAX_ATTACHMENT_BYTES = 8_192;

export interface NativeActorSocketPort {
  accept(protocol?: string, attachment?: Uint8Array): Promise<string>;
  get(socketId: string): Promise<boolean>;
  list(): Promise<readonly string[]>;
  send(socketId: string, data: string | Uint8Array): Promise<void>;
  close(socketId: string, code?: number, reason?: string): Promise<void>;
  getAttachment(socketId: string): Promise<Uint8Array | null>;
  setAttachment(socketId: string, value: Uint8Array | null): Promise<void>;
}

interface UpgradeRecord {
  readonly nonce: string;
  readonly socketId: string;
  readonly protocol?: string;
  readonly headers: [string, string][];
}

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

/** Host-private owner port. The application sees only the closed facade below. */
export interface NativeActorAlarmPort {
  set(atMillis: number): Promise<void>;
  get(): Promise<number | null>;
  clear(): Promise<void>;
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

export interface NativeActorExecutionOptions {
  readonly namespace: Readonly<Record<string, unknown>>;
  readonly exportName: string;
  readonly id: string;
  readonly env: Readonly<Record<string, unknown>>;
  readonly storage: NativeActorStorage;
  readonly alarm: NativeActorAlarmPort;
  /** Host-created broker facade. The adapter never creates native sockets. */
  readonly sockets?: Readonly<Record<string, unknown>>;
  /** Per-event Host-private broker port. Never projected to Actor code. */
  readonly socketPort?: (nonce: string) => NativeActorSocketPort;
}

export interface NativeActorExecutionResult {
  fetch(request: Request, socketNonce?: string): Promise<Response>;
  takeUpgrade(value: unknown, socketNonce: string): UpgradeRecord | null;
  alarm(signal: AbortSignal): Promise<void>;
  socketMessage(
    socket: object | string,
    data: string | Uint8Array,
    signal: AbortSignal,
    socketNonce?: string,
  ): Promise<void>;
  socketClose(
    socket: object | string,
    event: { readonly code: number; readonly reason: string; readonly wasClean: boolean },
    signal: AbortSignal,
    socketNonce?: string,
  ): Promise<void>;
}

export function createNativeActorExecution(
  options: NativeActorExecutionOptions,
): NativeActorExecutionResult {
  const unavailable = async (): Promise<never> => {
    throw new ActorRuntimeError("backend_unavailable");
  };
  const alarm = SafeObjectFreeze({
    async set(atMillis: number): Promise<void> {
      if (!Number.isSafeInteger(atMillis) || atMillis < 0)
        throw new TypeError("Actor alarm time must be a nonnegative safe integer");
      try {
        await options.alarm.set(atMillis);
      } catch {
        throw new ActorRuntimeError("backend_unavailable");
      }
    },
    async get(): Promise<number | null> {
      try {
        return await options.alarm.get();
      } catch {
        throw new ActorRuntimeError("backend_unavailable");
      }
    },
    async clear(): Promise<void> {
      try {
        await options.alarm.clear();
      } catch {
        throw new ActorRuntimeError("backend_unavailable");
      }
    },
  });
  type SocketTurn = {
    readonly kind: "fetch" | "message" | "close";
    readonly nonce: string;
    readonly port: NativeActorSocketPort;
  };
  let socketTurn: SocketTurn | undefined;
  const upgrades = new SafeWeakMap<object, UpgradeRecord>();
  const socketUnavailable = (): never => {
    throw new ActorRuntimeError("backend_unavailable");
  };
  const activePort = (): NativeActorSocketPort => socketTurn?.port ?? socketUnavailable();
  const copyBytes = (value: Uint8Array, maximum: number): Uint8Array => {
    let copy: Uint8Array;
    try {
      copy = SafeReflectApply(SafeUint8ArraySlice, value, []) as Uint8Array;
    } catch {
      throw new TypeError("Actor socket bytes must be Uint8Array");
    }
    if (copy.byteLength > maximum)
      throw new ActorRuntimeError(
        maximum === MAX_ATTACHMENT_BYTES ? "attachment_too_large" : "message_too_large",
      );
    return copy;
  };
  const handle = (id: string): object =>
    SafeObjectFreeze({
      id,
      async send(value: string | Uint8Array): Promise<void> {
        if (typeof value === "string") {
          const size = (
            SafeReflectApply(SafeTextEncode, new SafeTextEncoder(), [value]) as Uint8Array
          ).byteLength;
          if (size > MAX_SOCKET_MESSAGE_BYTES) throw new ActorRuntimeError("message_too_large");
          await activePort().send(id, value);
        } else await activePort().send(id, copyBytes(value, MAX_SOCKET_MESSAGE_BYTES));
      },
      async close(code?: number, reason?: string): Promise<void> {
        if (
          code !== undefined &&
          (!SafeNumberIsSafeInteger(code) || (code !== 1000 && (code < 3000 || code > 4999)))
        )
          throw new TypeError("Actor socket close code is invalid");
        if (
          reason !== undefined &&
          (typeof reason !== "string" ||
            (SafeReflectApply(SafeTextEncode, new SafeTextEncoder(), [reason]) as Uint8Array)
              .byteLength > 123)
        )
          throw new TypeError("Actor socket close reason is invalid");
        await activePort().close(id, code, reason);
      },
      async getAttachment(): Promise<Uint8Array | null> {
        const value = await activePort().getAttachment(id);
        return value === null ? null : copyBytes(value, MAX_ATTACHMENT_BYTES);
      },
      async setAttachment(value: Uint8Array | null): Promise<void> {
        await activePort().setAttachment(
          id,
          value === null ? null : copyBytes(value, MAX_ATTACHMENT_BYTES),
        );
      },
    });
  const sockets = options.socketPort
    ? SafeObjectFreeze({
        async accept(
          request: Request,
          acceptedOptions?: { readonly protocol?: string; readonly attachment?: Uint8Array },
        ): Promise<{ readonly response: Response; readonly socket: object }> {
          const turn = socketTurn;
          if (turn?.kind !== "fetch" || !SafeRequestMethod || !SafeRequestHeaders)
            return socketUnavailable();
          let method: string;
          let upgrade: string | null;
          try {
            method = SafeReflectApply(SafeRequestMethod, request, []) as string;
            const headers = SafeReflectApply(SafeRequestHeaders, request, []) as Headers;
            upgrade = SafeReflectApply(SafeHeadersGet, headers, ["upgrade"]) as string | null;
          } catch {
            throw new TypeError("Actor socket request must be a Request");
          }
          if (
            method !== "GET" ||
            upgrade === null ||
            SafeReflectApply(SafeStringLower, upgrade, []) !== "websocket"
          )
            throw new ActorRuntimeError("invalid_upgrade");
          if (
            acceptedOptions !== undefined &&
            (typeof acceptedOptions !== "object" ||
              acceptedOptions === null ||
              SafeReflectApply(
                SafeArraySome,
                SafeReflectApply(SafeObjectKeys, Object, [acceptedOptions]),
                [(key: string) => key !== "protocol" && key !== "attachment"],
              ))
          )
            throw new TypeError("Actor socket options are invalid");
          const protocol = acceptedOptions?.protocol;
          if (
            protocol !== undefined &&
            (typeof protocol !== "string" ||
              !SafeReflectApply(SafeRegExpTest, SOCKET_PROTOCOL, [protocol]))
          )
            throw new ActorRuntimeError("invalid_upgrade");
          const attachment =
            acceptedOptions?.attachment === undefined
              ? undefined
              : copyBytes(acceptedOptions.attachment, MAX_ATTACHMENT_BYTES);
          const socketId = await turn.port.accept(protocol, attachment);
          const outcome = createActorUpgradeResponse(
            new SafeHeaders(protocol ? { "sec-websocket-protocol": protocol } : undefined),
          );
          SafeReflectApply(SafeWeakMapSet, upgrades, [
            outcome,
            {
              nonce: turn.nonce,
              socketId,
              protocol,
              headers: [],
            },
          ]);
          return SafeObjectFreeze({ response: outcome, socket: handle(socketId) });
        },
        async get(id: string): Promise<object | null> {
          if (typeof id !== "string" || !id) throw new TypeError("Actor socket ID is invalid");
          return (await activePort().get(id)) ? handle(id) : null;
        },
        async list(): Promise<readonly object[]> {
          const ids = await activePort().list();
          return SafeObjectFreeze(
            SafeReflectApply(SafeArrayMap, ids, [(id: string) => handle(id)]) as object[],
          );
        },
      })
    : (options.sockets ??
      SafeObjectFreeze({ accept: unavailable, get: unavailable, list: unavailable }));
  const withSocketTurn = async <T>(
    kind: SocketTurn["kind"],
    nonce: string | undefined,
    callback: () => Promise<T>,
  ): Promise<T> => {
    if (!options.socketPort || nonce === undefined) return callback();
    if (socketTurn) return socketUnavailable();
    const turn: SocketTurn = { kind, nonce, port: options.socketPort(nonce) };
    socketTurn = turn;
    try {
      return await callback();
    } finally {
      if (socketTurn === turn) socketTurn = undefined;
    }
  };
  const classOptions = {
    namespace: options.namespace,
    exportName: options.exportName,
    env: options.env,
    context: createActorContext({
      id: options.id,
      storage: createSqlFacade(options.storage) as unknown as Readonly<Record<string, unknown>>,
      alarm,
      sockets,
    }),
  };
  const execution = createActorClassExecution(classOptions);
  return SafeObjectFreeze({
    async fetch(request: Request, socketNonce?: string): Promise<Response> {
      return withSocketTurn("fetch", socketNonce, async () => {
        const response = await execution.dispatch(
          { kind: "fetch", request },
          createActorTurn(request.signal),
        );
        if (response === undefined) throw new ActorRuntimeError("backend_unavailable");
        // The child shim alone converts a branded Response into a private
        // owner decision; no native socket enters the application Response.
        return response;
      });
    },
    takeUpgrade(value: unknown, socketNonce: string): UpgradeRecord | null {
      const source = actorUpgradeResponseSource(value);
      if (!source || !SafeResponseHeaders) return null;
      const record = SafeReflectApply(SafeWeakMapGet, upgrades, [source]) as
        | UpgradeRecord
        | undefined;
      if (!record || record.nonce !== socketNonce) return null;
      const headers = SafeReflectApply(SafeResponseHeaders, value, []) as Headers;
      const handshake = new SafeHeaders(
        record.protocol ? { "sec-websocket-protocol": record.protocol } : undefined,
      );
      if (!validActorUpgradeHeaders(headers, handshake))
        throw new ActorRuntimeError("invalid_upgrade");
      const snapshot: [string, string][] = [];
      SafeReflectApply(SafeHeadersForEach, headers, [
        (value: string, name: string) => {
          snapshot[snapshot.length] = [name, value];
        },
      ]);
      SafeReflectApply(SafeWeakMapDelete, upgrades, [source]);
      return { ...record, headers: snapshot };
    },
    async alarm(signal: AbortSignal): Promise<void> {
      await execution.dispatch({ kind: "alarm" }, createActorTurn(signal));
    },
    async socketMessage(
      socket: object | string,
      data: string | Uint8Array,
      signal: AbortSignal,
      socketNonce?: string,
    ): Promise<void> {
      await withSocketTurn("message", socketNonce, async () => {
        await execution.dispatch(
          {
            kind: "socketMessage",
            socket: typeof socket === "string" ? handle(socket) : socket,
            data,
          },
          createActorTurn(signal),
        );
      });
    },
    async socketClose(
      socket: object | string,
      event: { readonly code: number; readonly reason: string; readonly wasClean: boolean },
      signal: AbortSignal,
      socketNonce?: string,
    ): Promise<void> {
      await withSocketTurn("close", socketNonce, async () => {
        await execution.dispatch(
          {
            kind: "socketClose",
            socket: typeof socket === "string" ? handle(socket) : socket,
            event,
          },
          createActorTurn(signal),
        );
      });
    },
  });
}
